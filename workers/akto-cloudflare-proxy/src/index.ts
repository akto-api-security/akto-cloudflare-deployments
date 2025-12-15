/**
 * Akto Cloudflare Worker Proxy
 *
 * This worker acts as a transparent proxy that:
 * 1. Intercepts incoming HTTP/HTTPS and WebSocket traffic
 * 2. Forwards all requests to a target worker via the MCP service binding
 * 3. Mirrors traffic data to Akto data ingestion service for API discovery
 *
 * IMPORTANT CONFIGURATION REQUIREMENTS:
 * - MCP Service Binding: Configure in wrangler.jsonc to connect to your target worker
 *   The MCP binding is REQUIRED and must point to the worker you want to proxy traffic to
 *
 * - Data Ingestion Service: Replace <DATA_INGESTION_SERVICE> below with your Akto URL
 *   OR use a service binding if hosting the ingestion service as a Cloudflare worker
 */

export default {
    async fetch(request, env, ctx) {
    console.log("🚀 Worker handling:", request.method, request.url);

    // Detect WebSocket upgrade
    const upgradeHeader = request.headers.get("Upgrade") || "";
    const isWebSocket = upgradeHeader.toLowerCase() === "websocket";

    if (isWebSocket) {
        console.log("🔄 WebSocket upgrade detected");

        // IMPORTANT: MCP service binding proxies the connection to your target worker
        // Configure the MCP binding in wrangler.jsonc to point to your target worker
        const response = await env.MCP.fetch(request);

        // Clone headers only (no body to tee here)
        ctx.waitUntil(logTraffic(request, response, env, { isWebSocket: true }));

        return response;
    }

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

    // IMPORTANT: MCP service binding proxies the request to your target worker
    // Configure the MCP binding in wrangler.jsonc to point to your target worker
    const response = await env.MCP.fetch(requestForFetch);
    console.log("⬅️ Upstream response:", response.status);

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
    },
};

async function logTraffic(request, response, env, opts = {}) {
    try {
    console.log("📝 logTraffic running...");

    const reqContentType = request.headers.get("content-type") || "";
    const resContentType = response.headers.get("content-type") || "";
    const status = response.status;

    let reqBody = "";
    let resBody = "";

    if (!opts.isWebSocket) {
        // Only attempt to read bodies for HTTP
        reqBody = await readBodyAsText(request);
        resBody = await readBodyAsText(response);

        if (!(status >= 200 && status < 400)) {
        console.log("⚠️ Skipped log: status", status);
        return;
        }

        if (!reqContentType && !resContentType) {
        console.log("⚠️ Skipped log: no content-type in request or response");
        return;
        }

        if (!shouldCapture(reqContentType) && !shouldCapture(resContentType)) {
        console.log("⚠️ Skipped log: not a target content-type", { reqContentType, resContentType });
        return;
        }
    }

    const url = new URL(request.url);
    const logEntry = {
        path: url.pathname,
        method: request.method,
        requestHeaders: JSON.stringify(Object.fromEntries(request.headers)),
        responseHeaders: JSON.stringify(Object.fromEntries(response.headers)),
        requestPayload: reqBody,
        responsePayload: resBody,
        ip: request.headers.get("cf-connecting-ip") || "127.0.0.1",
        time: Math.floor(Date.now() / 1000).toString(),
        statusCode: status.toString(),
        type: opts.isWebSocket ? "WebSocket" : "HTTP/1.1",
        status: response.statusText || "OK",
        akto_account_id: "1000000",
        akto_vxlan_id: "0",
        is_pending: "false",
        source: "MIRRORING",
        tag: "{\n  \"service\": \"cloudflare\"\n}"
    };

    console.log("📤 Sending log entry to webhook...");

    // IMPORTANT: Replace <DATA_INGESTION_SERVICE> with your Akto data ingestion service URL
    // Example: "https://traffic.domain.com/api/ingestData"
    //
    // ALTERNATIVE: If using a service binding for your Akto ingestion service:
    // 1. Add a service binding in wrangler.jsonc (e.g., AKTO_INGESTION)
    // 2. Replace the fetch call below with: await env.AKTO_INGESTION.fetch(aktoReq)
    const aktoReq = new Request("https://<DATA_INGESTION_SERVICE>/api/ingestData", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ batchData: [logEntry] }),
    });

    // await env.<CONTAINER_BINDING_VARIABLE_NAME>.fetch(aktoReq);
    const aktoResp = await fetch(aktoReq);

    if (aktoResp.status == 200) {
        console.log("✅ Log sent to akto");
    } else {
        console.log("❌ Failed to send data to Akto. Response Status: " + aktoResp?.status);
    }
    } catch (err) {
    console.error("❌ Log error:", err);
    }
}

function shouldCapture(contentType) {
    const targets = ["json", "xml", "x-www-form-urlencoded", "soap", "grpc"];
    return targets.some((t) => contentType.toLowerCase().includes(t));
}

async function readBodyAsText(obj, maxSize = 64 * 1024) {
    try {
    const buf = await obj.arrayBuffer();
    const bytes = new Uint8Array(buf).slice(0, maxSize);
    return new TextDecoder().decode(bytes);
    } catch {
    return "";
    }
}
