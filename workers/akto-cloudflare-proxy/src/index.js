// ─── Akto Cloudflare Proxy ────────────────────────────────────────────────────
//
// Transparent proxy that sits in front of your application via a Cloudflare
// route rule. Supports two guardrails modes:
//
//   async (default): proxy → stream response to client →
//                    ctx.waitUntil(guardrails + ingest via /api/http-proxy)
//
//   blocked:         validate request → proxy → validate response + ingest → return
//                    (returns 400 if request or response is blocked by policy)
//
// Required bindings (wrangler.jsonc → services):
//   AKTO_INGESTION_WORKER   Service binding to the akto-ingest-guardrails worker
//
// Environment variables (wrangler.jsonc → vars):
//   APPLY_AKTO_GUARDRAILS     Enable guardrails. Values: "true" / "false"
//   AKTO_GUARDRAILS_MODE      "async" (default) or "blocked"
//   AKTO_ENDPOINTS_TO_GUARD   Optional comma-separated path substrings to guard.
//                             Leave empty to guard all endpoints.
//   AKTO_ACCOUNT_ID           Your Akto account ID (default: "1000000")
// ─────────────────────────────────────────────────────────────────────────────

export default {
	async fetch(request, env, ctx) {
		console.log('[Akto Proxy] Handling:', request.method, request.url);

		const upgradeHeader = request.headers.get('Upgrade') || '';
		const isWebSocket = upgradeHeader.toLowerCase() === 'websocket';

		if (isWebSocket) {
			console.log('[Akto Proxy] WebSocket — passing through');
			const response = await fetch(request);
			ctx.waitUntil(logTraffic(request, '', response, '', env, { isWebSocket: true }));
			return response;
		}

		const useGuardrails = shouldApplyGuardrails(request, env);
		const guardrailsMode = (env?.AKTO_GUARDRAILS_MODE || 'async').toLowerCase();
		console.log(`[Akto Proxy] guardrails=${useGuardrails} mode=${guardrailsMode} for ${request.url}`);

		// Read request body once; reuse bytes for upstream + guardrails + logging
		let reqBodyText = '';
		let requestForFetch;
		if (request.body) {
			const bodyBytes = await request.arrayBuffer();
			reqBodyText = readBytesAsText(bodyBytes);
			requestForFetch = new Request(request, { body: bodyBytes });
		} else {
			requestForFetch = request;
		}

		// ── No guardrails: proxy → stream → async ingest ─────────────────────────
		if (!useGuardrails) {
			const response = await fetch(requestForFetch);
			console.log('[Akto Proxy] Upstream:', response.status);

			const { responseForClient, logPromise } = buildStreamingResponse(response);
			ctx.waitUntil(
				logPromise
					.then((resBody) => logTraffic(request, reqBodyText, response, resBody, env))
					.catch((e) => console.error('[Akto Proxy] pipe error:', e)),
			);
			return responseForClient;
		}

		// ── Async guardrails: proxy → stream → async guardrails+ingest ───────────
		if (guardrailsMode !== 'blocked') {
			const response = await fetch(requestForFetch);
			console.log('[Akto Proxy] Upstream:', response.status);

			const { responseForClient, logPromise } = buildStreamingResponse(response);
			ctx.waitUntil(
				logPromise
					.then((resBody) => runGuardrailsAsync(request, reqBodyText, response, resBody, env))
					.catch((e) => console.error('[Akto Proxy] async guardrails error:', e)),
			);
			return responseForClient;
		}

		// ── Blocked guardrails: validate request → proxy → validate response ─────
		if (request.body) {
			const reqHook = await validateGuardrails(request, reqBodyText, env, 'request');
			if (reqHook.type === 'block') {
				console.log('[Akto Proxy] Request BLOCKED:', reqHook.reason);
				return blockedResponse(reqHook.reason);
			}
		}

		const response = await fetch(requestForFetch);
		console.log('[Akto Proxy] Upstream:', response.status);

		// Buffer response to validate it before returning to client
		const resBodyBytes = await response.arrayBuffer();
		const resBodyText = readBytesAsText(resBodyBytes);

		// ingest_data=true means the ingest-guardrails worker also forwards to the container
		const resHook = await validateGuardrails(request, reqBodyText, env, 'response', response, resBodyText);
		if (resHook.type === 'block') {
			console.log('[Akto Proxy] Response BLOCKED:', resHook.reason);
			return blockedResponse(resHook.reason);
		}

		return new Response(resBodyBytes, response);
	},
};

// ─── Streaming response helper ────────────────────────────────────────────────
function buildStreamingResponse(response) {
	if (!response.body) {
		return { responseForClient: response, logPromise: Promise.resolve('') };
	}
	const logChunks = [];
	const { readable, writable } = new TransformStream(
		{
			transform(chunk, controller) {
				logChunks.push(chunk);
				controller.enqueue(chunk);
			},
		},
		new ByteLengthQueuingStrategy({ highWaterMark: 256 * 1024 }),
		new ByteLengthQueuingStrategy({ highWaterMark: 256 * 1024 }),
	);
	const logPromise = response.body.pipeTo(writable, { preventCancel: true }).then(() => {
		const merged = new Uint8Array(logChunks.reduce((s, c) => s + c.length, 0));
		let offset = 0;
		for (const c of logChunks) { merged.set(c, offset); offset += c.length; }
		return readBytesAsText(merged.buffer);
	});
	return { responseForClient: new Response(readable, response), logPromise };
}

// ─── Traffic logging (no-guardrails path) ─────────────────────────────────────
async function logTraffic(request, reqBody, response, resBody, env, opts = {}) {
	if (!env.AKTO_INGESTION_WORKER) {
		console.warn('[Akto Proxy] AKTO_INGESTION_WORKER binding missing — skipping ingest');
		return;
	}

	try {
		const reqContentType = request.headers.get('content-type') || '';
		const resContentType = response?.headers?.get('content-type') || '';
		const status = response?.status ?? 0;

		if (!opts.isWebSocket) {
			if (status && !(status >= 200 && status < 400)) return;
			if (!reqContentType && !resContentType) return;
			if (!shouldCapture(reqContentType) && !shouldCapture(resContentType)) return;
		}

		const logEntry = buildLogEntry(request, { requestPayload: reqBody, response, responsePayload: resBody, opts }, env);

		const resp = await env.AKTO_INGESTION_WORKER.fetch(
			new Request('https://akto-ingest/api/ingestData', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ batchData: [logEntry] }),
			}),
		);
		if (resp.ok) {
			console.log('[Akto Proxy] Traffic ingested');
		} else {
			console.warn('[Akto Proxy] Ingest returned:', resp.status);
		}
	} catch (err) {
		console.error('[Akto Proxy] Ingest error:', err);
	}
}

// ─── Async guardrails ─────────────────────────────────────────────────────────
async function runGuardrailsAsync(request, reqBodyText, response, resBodyText, env) {
	if (!env.AKTO_INGESTION_WORKER) {
		console.warn('[Akto Proxy] AKTO_INGESTION_WORKER binding missing — skipping async guardrails');
		return;
	}

	const logEntry = buildLogEntry(request, { requestPayload: reqBodyText, response, responsePayload: resBodyText }, env);

	try {
		const res = await env.AKTO_INGESTION_WORKER.fetch(
			new Request('https://akto-ingest/api/http-proxy?guardrails=true&akto_connector=cloudflare&ingest_data=true', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(logEntry),
			}),
		);
		const text = await res.text();
		const json = JSON.parse(text);
		const gr = json?.data?.guardrailsResult;
		console.log(`[Akto Proxy] Async guardrails: allowed=${gr?.Allowed ?? true} reason=${gr?.Reason ?? ''}`);
	} catch (e) {
		console.error('[Akto Proxy] Async guardrails error:', e);
	}
}

// ─── Blocked-mode guardrails ──────────────────────────────────────────────────
async function validateGuardrails(request, reqBodyText, env, phase = 'request', response = null, resBodyText = '') {
	if (!env.AKTO_INGESTION_WORKER) {
		console.warn('[Akto Proxy] AKTO_INGESTION_WORKER binding missing — skipping guardrails');
		return { type: 'proceed' };
	}

	const isResponsePhase = phase === 'response';
	const ingestData = isResponsePhase ? 'true' : 'false';
	const logEntry = buildLogEntry(
		request,
		{ requestPayload: reqBodyText, response: isResponsePhase ? response : null, responsePayload: isResponsePhase ? resBodyText : '' },
		env,
	);

	try {
		const res = await env.AKTO_INGESTION_WORKER.fetch(
			new Request(`https://akto-ingest/api/http-proxy?guardrails=true&akto_connector=cloudflare&ingest_data=${ingestData}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(logEntry),
			}),
		);
		const text = await res.text();
		console.log(`[Akto Proxy] Guardrails ${phase} response:`, text.slice(0, 200));

		const json = JSON.parse(text);
		const gr = json?.data?.guardrailsResult;
		const allowed = gr?.Allowed ?? true;
		const reason  = gr?.Reason  ?? '';

		if (!allowed) return { type: 'block', reason };
	} catch (e) {
		console.error('[Akto Proxy] Guardrails fetch error:', e);
	}

	return { type: 'proceed' };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function shouldApplyGuardrails(request, env) {
	const v = env?.APPLY_AKTO_GUARDRAILS;
	const enabled = v === true || v === 'true' || v === '1';
	if (!enabled) return false;
	if (request.method === 'DELETE') return false;

	const raw = env?.AKTO_ENDPOINTS_TO_GUARD;
	if (typeof raw !== 'string' || raw.trim() === '') return true;

	const requestPath = new URL(request.url).pathname.toLowerCase();
	return raw
		.split(',')
		.map((s) => s.trim().replace(/^\/+/, '').toLowerCase())
		.filter(Boolean)
		.some((needle) => requestPath.includes(needle));
}

const HOP_BY_HOP = new Set([
	'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
	'te', 'trailer', 'transfer-encoding', 'upgrade', 'accept-encoding',
]);

function headersToObject(headers, stripHopByHop = false) {
	const obj = {};
	headers.forEach((value, key) => {
		if (!stripHopByHop || !HOP_BY_HOP.has(key.toLowerCase())) obj[key] = value;
	});
	return obj;
}

function buildLogEntry(request, { requestPayload, response, responsePayload, opts = {} }, env) {
	const url = new URL(request.url);
	const hasRes = response != null;
	const statusCode = hasRes ? String(response.status) : '0';
	const tag = JSON.stringify({ 'gen-ai': 'Gen AI', 'mcp-server': 'MCP Server', source: 'cloudflare' });
	return {
		path: url.pathname,
		method: request.method,
		requestHeaders: JSON.stringify(headersToObject(request.headers, true)),
		responseHeaders: hasRes ? JSON.stringify(headersToObject(response.headers, true)) : '{}',
		requestPayload: requestPayload || '',
		responsePayload: responsePayload || '',
		ip: request.headers.get('cf-connecting-ip') || '127.0.0.1',
		destIp: '127.0.0.1',
		time: Math.floor(Date.now() / 1000).toString(),
		statusCode,
		type: opts.isWebSocket ? 'WebSocket' : 'HTTP/1.1',
		status: statusCode,
		akto_account_id: env?.AKTO_ACCOUNT_ID || '1000000',
		akto_vxlan_id: '0',
		is_pending: 'false',
		source: 'MIRRORING',
		direction: null,
		process_id: null,
		socket_id: null,
		daemonset_id: null,
		enabled_graph: null,
		tag,
		metadata: tag,
		contextSource: 'AGENTIC',
	};
}

function blockedResponse(reason) {
	return new Response(
		JSON.stringify({ error: 'Request blocked by security policy', reason: reason || '' }),
		{ status: 400, headers: { 'content-type': 'application/json' } },
	);
}

function readBytesAsText(buf, maxSize = 64 * 1024) {
	return new TextDecoder().decode(new Uint8Array(buf).slice(0, maxSize));
}

function shouldCapture(contentType) {
	return ['json', 'xml', 'x-www-form-urlencoded', 'soap', 'grpc', 'event-stream'].some(
		(t) => contentType.toLowerCase().includes(t),
	);
}
