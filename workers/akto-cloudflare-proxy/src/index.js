// ─── Akto Cloudflare Proxy ────────────────────────────────────────────────────
//
// Transparent proxy that sits in front of your application via a Cloudflare
// route rule. For every request it:
//   1. Optionally validates the request through Akto guardrails (blocking)
//   2. Forwards the request to the origin (fetch passes through to your server)
//   3. Streams the response back to the client
//   4. Asynchronously logs the traffic to Akto for API discovery
//
// Required bindings (wrangler.jsonc → services):
//   AKTO_INGESTION_WORKER   Service binding to the akto-ingest-guardrails worker
//
// Environment variables (wrangler.jsonc → vars):
//   APPLY_AKTO_GUARDRAILS     Enable guardrails. Values: "true" / "false"
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
		console.log(`[Akto Proxy] guardrails=${useGuardrails} for ${request.url}`);

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

		// ── Without guardrails: proxy → log ──────────────────────────────────────
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

		// ── With guardrails: validate request → proxy → log ──────────────────────
		if (request.body) {
			const reqHook = await validateGuardrails(request, reqBodyText, env);
			if (reqHook.type === 'block') {
				console.log('[Akto Proxy] Request BLOCKED:', reqHook.reason);
				return blockedResponse(reqHook.reason);
			}
		}

		const requestPayloadSent = reqBodyText;

		const response = await fetch(requestForFetch);
		console.log('[Akto Proxy] Upstream:', response.status);

		const { responseForClient, logPromise } = buildStreamingResponse(response);
		ctx.waitUntil(
			logPromise
				.then((resBody) => logTraffic(request, requestPayloadSent, response, resBody, env))
				.catch((e) => console.error('[Akto Proxy] pipe error:', e)),
		);

		return responseForClient;
	},
};

// ─── Streaming response helper ────────────────────────────────────────────────
// Tees the response body: one copy streams to the client, the other accumulates
// for async logging. logPromise resolves with the full response body text once
// the stream is complete.
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

// ─── Traffic logging ──────────────────────────────────────────────────────────
async function logTraffic(request, reqBody, response, resBody, env, opts = {}) {
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

		if (!env.AKTO_INGESTION_WORKER) {
			console.warn('[Akto Proxy] AKTO_INGESTION_WORKER binding missing — skipping ingest');
			return;
		}

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

// ─── Guardrails ───────────────────────────────────────────────────────────────
// Calls akto-ingest-guardrails /api/http-proxy?guardrails=true&ingest_data=false
// with the full traffic log entry (same payload as Kong uses).
// Returns { type: 'proceed' | 'block' }
async function validateGuardrails(request, reqBodyText, env) {
	if (!env.AKTO_INGESTION_WORKER) {
		console.warn('[Akto Proxy] AKTO_INGESTION_WORKER binding missing — skipping guardrails');
		return { type: 'proceed' };
	}

	// Build full log entry (same shape as what logTraffic sends)
	const logEntry = buildLogEntry(request, { requestPayload: reqBodyText, response: null, responsePayload: '' }, env);

	try {
		const res = await env.AKTO_INGESTION_WORKER.fetch(
			new Request('https://akto-ingest/api/http-proxy?guardrails=true&akto_connector=cloudflare&ingest_data=false', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(logEntry),
			}),
		);
		const text = await res.text();
		console.log('[Akto Proxy] Guardrails request response:', text.slice(0, 200));

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

function headersToObject(headers) {
	const obj = {};
	headers.forEach((value, key) => { obj[key] = value; });
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
		requestHeaders: JSON.stringify(headersToObject(request.headers)),
		responseHeaders: hasRes ? JSON.stringify(headersToObject(response.headers)) : '{}',
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

function requestWithBody(request, bodyText) {
	const headers = new Headers(request.headers);
	headers.delete('content-length');
	const init = { method: request.method, headers };
	if (!['GET', 'HEAD'].includes(request.method)) init.body = bodyText;
	return new Request(request.url, init);
}

function readBytesAsText(buf, maxSize = 64 * 1024) {
	return new TextDecoder().decode(new Uint8Array(buf).slice(0, maxSize));
}

function shouldCapture(contentType) {
	return ['json', 'xml', 'x-www-form-urlencoded', 'soap', 'grpc', 'event-stream'].some(
		(t) => contentType.toLowerCase().includes(t),
	);
}
