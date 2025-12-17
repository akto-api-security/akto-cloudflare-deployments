/**
 * Akto Cloudflare Worker Proxy
 *
 * This worker acts as a transparent proxy that:
 * 1. Intercepts incoming HTTP/HTTPS and WebSocket traffic
 * 2. Forwards all requests to a target worker via the MCP service binding
 * 3. Validates requests/responses via guardrails service (async or blocked mode)
 * 4. Mirrors traffic data to Akto data ingestion service for API discovery
 *
 * MODES:
 * - async: Validate in background, never block traffic (default)
 * - blocked: Validate before forwarding, block malicious requests/responses
 *
 * IMPORTANT CONFIGURATION REQUIREMENTS:
 * - MCP Service Binding: Configure in wrangler.jsonc to connect to your target worker
 * - AKTO_GUARDRAILS Service Binding: For validation in blocked mode
 * - GUARDRAILS_MODE: Set to "async" or "blocked" in wrangler.jsonc
 */

import type { ProxyEnv } from "./types";
import {
  validateRequest,
  validateResponse,
  createBlockedResponse,
  extractRequestId,
  buildLogEntry,
  ingestLogEntry,
} from "./blocking";

export default {
  async fetch(request: Request, env: ProxyEnv, ctx: ExecutionContext): Promise<Response> {
    console.log("🚀 Worker handling:", request.method, request.url);

    const guardrailsMode = (env.GUARDRAILS_MODE || "async").toLowerCase();
    console.log(`🔧 Guardrails mode: ${guardrailsMode}`);

    const upgradeHeader = request.headers.get("Upgrade") || "";
    const isWebSocket = upgradeHeader.toLowerCase() === "websocket";

    if (isWebSocket) {
      console.log("🔄 WebSocket upgrade detected");
      const response = await env.MCP.fetch(request);
      ctx.waitUntil(logTraffic(request, response, env, { isWebSocket: true }));
      return response;
    }

    if (guardrailsMode === "blocked") {
      return handleBlockedMode(request, env, ctx);
    } else {
      return handleAsyncMode(request, env, ctx);
    }
  },
};

async function handleAsyncMode(
  request: Request,
  env: ProxyEnv,
  ctx: ExecutionContext
): Promise<Response> {
  console.log("📤 [Async Mode] Forwarding request without validation");

  let requestForFetch: Request;
  let requestForLog: Request;

  if (request.body) {
    const [req1, req2] = request.body.tee();
    requestForFetch = new Request(request, { body: req1 });
    requestForLog = new Request(request, { body: req2 });
  } else {
    requestForFetch = request;
    requestForLog = request.clone();
  }

  const response = await env.MCP.fetch(requestForFetch);
  console.log("⬅️ Upstream response:", response.status);

  let responseForClient: Response;
  let responseForLog: Response;

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

async function handleBlockedMode(
  request: Request,
  env: ProxyEnv,
  ctx: ExecutionContext
): Promise<Response> {
  console.log("🛡️ [Blocked Mode] Starting validation flow");

  const requestBody = await readBodyAsText(request);
  console.log(`📝 Request body length: ${requestBody.length} bytes`);

  console.log("🔍 [Blocked Mode] Phase 1: Validating request");
  const requestValidation = await validateRequest(requestBody, request, env);

  if (requestValidation.shouldBlock) {
    console.log("🚫 [Blocked Mode] Request BLOCKED:", requestValidation.reason);

    const requestId = extractRequestId(requestBody);
    const blockedResponse = createBlockedResponse(
      requestValidation.reason || "Request blocked by security policy",
      requestValidation.metadata,
      requestId
    );

    const blockedResponseBody = await blockedResponse.text();

    const logEntry = buildLogEntry(
      request,
      new Response(blockedResponseBody, blockedResponse),
      requestBody,
      blockedResponseBody,
      true,
      "request"
    );

    ctx.waitUntil(ingestLogEntry(logEntry, env));

    return new Response(blockedResponseBody, {
      status: blockedResponse.status,
      headers: blockedResponse.headers,
    });
  }

  console.log("✅ [Blocked Mode] Request validation passed");

  console.log("📤 [Blocked Mode] Phase 2: Forwarding to MCP server");

  const forwardRequest = new Request(request, {
    body: requestBody || null,
  });

  const mcpResponse = await env.MCP.fetch(forwardRequest);
  console.log(`⬅️ [Blocked Mode] MCP response: ${mcpResponse.status}`);

  const mcpResponseBody = await readBodyAsText(mcpResponse);
  console.log(`📝 Response body length: ${mcpResponseBody.length} bytes`);

  console.log("🔍 [Blocked Mode] Phase 3: Validating response");
  const responseValidation = await validateResponse(
    requestBody,
    mcpResponseBody,
    request,
    mcpResponse.status,
    env
  );

  if (responseValidation.shouldBlock) {
    console.log("🚫 [Blocked Mode] Response BLOCKED:", responseValidation.reason);

    const requestId = extractRequestId(requestBody);
    const blockedResponse = createBlockedResponse(
      responseValidation.reason || "Response blocked by security policy",
      responseValidation.metadata,
      requestId
    );

    const blockedResponseBody = await blockedResponse.text();

    const logEntry = buildLogEntry(
      request,
      new Response(blockedResponseBody, blockedResponse),
      requestBody,
      blockedResponseBody,
      true,
      "response"
    );

    ctx.waitUntil(ingestLogEntry(logEntry, env));

    return new Response(blockedResponseBody, {
      status: blockedResponse.status,
      headers: blockedResponse.headers,
    });
  }

  console.log("✅ [Blocked Mode] Response validation passed");

  console.log("📨 [Blocked Mode] Phase 4: Returning response to client");

  const logEntry = buildLogEntry(
    request,
    new Response(mcpResponseBody, mcpResponse),
    requestBody,
    mcpResponseBody,
    false
  );

  ctx.waitUntil(ingestLogEntry(logEntry, env));

  return new Response(mcpResponseBody, {
    status: mcpResponse.status,
    statusText: mcpResponse.statusText,
    headers: mcpResponse.headers,
  });
}

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

    console.log("📤 Sending log entry...");

    if (env.AKTO_INGEST_GUARDRAILS) {
        const response = await env.AKTO_INGEST_GUARDRAILS.fetch(
            new Request("http://internal/api/ingestData", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ batchData: [logEntry] }),
            })
        );
        console.log(response.ok ? "✅ Log sent" : "❌ Failed:", response.status);
    } else if (env.DATA_INGESTION_URL) {
        const response = await fetch(env.DATA_INGESTION_URL + "/api/ingestData", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ batchData: [logEntry] }),
        });
        console.log(response.ok ? "✅ Log sent" : "❌ Failed:", response.status);
    } else {
        console.warn("⚠️ No ingestion service configured");
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
