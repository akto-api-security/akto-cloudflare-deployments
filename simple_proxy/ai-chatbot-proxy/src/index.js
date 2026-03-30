const TARGET = 'https://chat-history-keeper--nayanantiya.replit.app';

function guardrailsServiceBaseUrl(env) {
	const u = env?.AKTO_GUARDRAILS_URL;
	if (typeof u === 'string' && u.trim() !== '') {
		return u.trim().replace(/\/$/, '');
	}
	return null;
}

export default {
	async fetch(request, env, ctx) {
		console.log('🚀 Worker handling:', request.method, request.url);

		const upgradeHeader = request.headers.get('Upgrade') || '';
		const isWebSocket = upgradeHeader.toLowerCase() === 'websocket';

		if (isWebSocket) {
			console.log('🔄 WebSocket upgrade detected');

			// Just proxy the connection
			const response = await proxyToUpstream(request);

			// Clone headers only (no body to tee here)
			ctx.waitUntil(logTraffic(request, response, env, { isWebSocket: true }));

			return response;
		}

		const useGuardrails = guardrailsEnabled(env);

		let requestForFetch;
		let requestForLog;
		let responseForClient;
		let responseForLogTraffic;

		if (!useGuardrails) {
			// Normal HTTP(S) traffic
			let requestForFetch, requestForLog;
			if (request.body) {
				const [req1, req2] = request.body.tee();
				requestForFetch = new Request(request, { body: req1 });
				requestForLog = new Request(request, { body: req2 });
			} else {
				requestForFetch = request;
				requestForLog = request.clone();
			}

			const response = await fetch(requestForFetch);
			console.log('⬅️ Upstream response:', response.status);

			let responseForClient, responseForLog;
			if (response.body) {
				const [res1, res2] = response.body.tee();
				responseForClient = new Response(res1, response);
				responseForLog = new Response(res2, response);
			} else {
				responseForClient = response;
				responseForLog = response.clone();
			}

			ctx.waitUntil(logTraffic(requestForLog, responseForLog, env));

			return responseForClient;
		}

		// Guardrails on: request hook only when there is a body (validate reads stream)
		let reqBodyForValidate = '';
		let reqHook = { type: 'proceed', gr: null };
		if (request.body) {
			const [reqUpstream, reqRest] = request.body.tee();
			const [reqForGuard, reqForLogStream] = reqRest.tee();
			reqBodyForValidate = await readBodyAsText(new Request(request, { body: reqForGuard }));

			const beforeEntry = buildLogEntry(request, {
				requestPayload: reqBodyForValidate,
				response: null,
				responsePayload: '',
			});
			reqHook = await validateGuardrails('request', beforeEntry, env);
			if (reqHook.type === 'block') {
				return guardrailsBlockedResponse(reqHook.gr);
			}
			if (reqHook.type === 'modified') {
				requestForFetch = requestWithBody(request, String(reqHook.gr.ModifiedPayload));
				requestForLog = requestForFetch.clone();
			} else {
				requestForFetch = new Request(request, { body: reqUpstream });
				requestForLog = new Request(request, { body: reqForLogStream });
			}
		} else {
			requestForFetch = request;
			requestForLog = request.clone();
		}

		const requestPayloadSent = reqHook.type === 'modified' ? String(reqHook.gr.ModifiedPayload) : request.body ? reqBodyForValidate : '';

		const response = await proxyToUpstream(requestForFetch);
		console.log('⬅️ Upstream response:', response.status);

		let resBodyForValidate = '';
		let resLogStream = null;
		if (response.body) {
			const [resClient, resRest] = response.body.tee();
			const [resForGuard, logStream] = resRest.tee();
			resLogStream = logStream;
			responseForClient = new Response(resClient, response);
			resBodyForValidate = await readBodyAsText(new Response(resForGuard, response));
		} else {
			responseForClient = response;
			responseForLogTraffic = response.clone();
		}

		const afterEntry = buildLogEntry(request, {
			requestPayload: requestPayloadSent,
			response,
			responsePayload: resBodyForValidate,
		});
		const resHook = await validateGuardrails('response', afterEntry, env);

		if (resHook.type === 'block') {
			responseForClient = guardrailsBlockedResponse(resHook.gr);
			responseForLogTraffic = responseForClient.clone();
		} else if (resHook.type === 'modified') {
			responseForClient = modifiedUpstreamBodyResponse(response, resHook.gr.ModifiedPayload);
			responseForLogTraffic = responseForClient.clone();
		} else if (resLogStream != null) {
			responseForLogTraffic = new Response(resLogStream, response);
		}

		ctx.waitUntil(logTraffic(requestForLog, responseForLogTraffic, env));
		return responseForClient;
	},
};

async function logTraffic(request, response, env, opts = {}) {
	try {
		console.log('📝 logTraffic running...');

		const reqContentType = request.headers.get('content-type') || '';
		const resContentType = response.headers.get('content-type') || '';
		const status = response.status;

		let reqBody = '';
		let resBody = '';

		if (!opts.isWebSocket) {
			reqBody = await readBodyAsText(request);
			resBody = await readBodyAsText(response);

			if (!(status >= 200 && status < 400)) {
				console.log('⚠️ Skipped log: status', status);
				return;
			}

			if (!reqContentType && !resContentType) {
				console.log('⚠️ Skipped log: no content-type in request or response');
				return;
			}

			if (!shouldCapture(reqContentType) && !shouldCapture(resContentType)) {
				console.log('⚠️ Skipped log: not a target content-type', { reqContentType, resContentType });
				return;
			}
		}

		const logEntry = buildLogEntry(request, {
			requestPayload: reqBody,
			response,
			responsePayload: resBody,
			opts,
		});

		console.log('📋 Log entry:', JSON.stringify(logEntry, null, 2));
		console.log('📤 Sending log entry to webhook...');

		const aktoReq = new Request('https://<DATA_INGESTION_SERVICE>/api/ingestData', {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-api-key': 'YOUR_AKTO_API_KEY' },
			body: JSON.stringify({ batchData: [logEntry] }),
		});

		// await env.<CONTAINER_BINDING_VARIABLE_NAME>.fetch(aktoReq);
		const aktoResp = await fetch(aktoReq);

		if (aktoResp.status == 200) {
			console.log('✅ Log sent to akto');
		} else {
			console.log('❌ Failed to send data to Akto. Response Status: ' + aktoResp?.status);
		}
	} catch (err) {
		console.error('❌ Log error:', err);
	}
}

function shouldCapture(contentType) {
	const targets = ['json', 'xml', 'x-www-form-urlencoded', 'soap', 'grpc'];
	return targets.some((t) => contentType.toLowerCase().includes(t));
}

async function readBodyAsText(obj, maxSize = 64 * 1024) {
	try {
		const buf = await obj.arrayBuffer();
		const bytes = new Uint8Array(buf).slice(0, maxSize);
		return new TextDecoder().decode(bytes);
	} catch {
		return '';
	}
}

function guardrailsEnabled(env) {
	const v = env?.APPLY_AKTO_GUARDRAILS;
	if (v === true) return true;
	if (typeof v === 'string') return v === 'true' || v === '1';
	return false;
}

// Temporary for local/testing: rewrites URL to TARGET. Replace all proxyToUpstream(req) with fetch(req).
async function proxyToUpstream(request) {
	try {
		const url = new URL(request.url);
		const targetUrl = TARGET + url.pathname + url.search;
		const newRequest = new Request(targetUrl, {
			method: request.method,
			headers: request.headers,
			body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
			redirect: 'follow',
		});
		return await fetch(newRequest);
	} catch (err) {
		return new Response('Proxy error: ' + err.message, { status: 500 });
	}
}

function buildLogEntry(request, { requestPayload, response = null, responsePayload = '', opts = {} }) {
	const url = new URL(request.url);
	const hasRes = response != null;
	return {
		path: url.pathname,
		method: request.method,
		requestHeaders: JSON.stringify(Object.fromEntries(request.headers)),
		responseHeaders: hasRes ? JSON.stringify(Object.fromEntries(response.headers)) : '{}',
		requestPayload,
		responsePayload,
		ip: request.headers.get('cf-connecting-ip') || '127.0.0.1',
		time: Math.floor(Date.now() / 1000).toString(),
		statusCode: hasRes ? String(response.status) : '0',
		type: opts.isWebSocket ? 'WebSocket' : 'HTTP/1.1',
		status: hasRes ? response.statusText || 'OK' : '',
		akto_account_id: '1000000',
		akto_vxlan_id: '0',
		is_pending: 'false',
		source: 'MIRRORING',
		tag: '{\n  "service": "cloudflare"\n}',
	};
}

async function validateGuardrails(phase, logEntry, env) {
	const base = guardrailsServiceBaseUrl(env);
	if (!base) {
		console.warn('⚠️ AKTO_GUARDRAILS_URL is missing or empty; skipping guardrails (' + phase + ')');
		return { type: 'proceed', gr: null };
	}
	console.log("calling guardrails: ", JSON.stringify(logEntry))
	const url = `${base}/api/validate/${phase}`;
	let gr = { Allowed: true, Modified: false }
	try {
		const res = await fetch(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(logEntry),
		});
		const text = await res.text();
		console.log('response from guardrail: ', text);
		console.log('response from guardrail: ', text);
		try {
			gr = JSON.parse(text);
		} catch {
			console.log('⚠️ Guardrails non-JSON response:', res.status, text.slice(0, 200));
		}
	} catch (e) {
		console.error('⚠️ Guardrails fetch error:', e);
	}
	if (!gr || typeof gr.Allowed !== 'boolean') return { type: 'proceed', gr };
	if (!gr.Allowed) return { type: 'block', gr };
	if (gr.Modified === true && gr.ModifiedPayload != null && String(gr.ModifiedPayload).length > 0) {
		return { type: 'modified', gr };
	}
	return { type: 'proceed', gr };
}

function guardrailsBlockedBody(gr) {
	return JSON.stringify({
		error: 'This request is blocked due to security reasons',
		reason: gr?.Reason ?? '',
	});
}

function guardrailsBlockedResponse(gr) {
	return new Response(guardrailsBlockedBody(gr), {
		status: 400,
		headers: { 'content-type': 'application/json' },
	});
}

/** Same URL/method/headers; new body string for downstream (Content-Length stripped). */
function requestWithBody(request, bodyText) {
	const headers = new Headers(request.headers);
	headers.delete('content-length');
	const init = { method: request.method, headers };
	if (!['GET', 'HEAD'].includes(request.method)) {
		init.body = bodyText;
	}
	return new Request(request.url, init);
}

function modifiedUpstreamBodyResponse(originalResponse, payload) {
	const headers = new Headers(originalResponse.headers);
	headers.delete('content-length');
	return new Response(payload, {
		status: originalResponse.status,
		statusText: originalResponse.statusText,
		headers,
	});
}
