import type { ProxyEnv, ValidationResult, LogEntry } from "./types";

export async function validateRequest(
  payload: string,
  request: Request,
  env: ProxyEnv
): Promise<ValidationResult> {
  if (!env.AKTO_GUARDRAILS) {
    console.log("[Blocking] No guardrails binding, skipping validation");
    return {
      allowed: true,
      shouldBlock: false,
      action: "ALLOW",
    };
  }

  try {
    const url = new URL(request.url);
    const validationRequest = {
      payload,
      context: {
        ip: request.headers.get("cf-connecting-ip") || "127.0.0.1",
        endpoint: url.pathname,
        method: request.method,
        requestHeaders: Object.fromEntries(request.headers),
      },
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    try {
      const response = await env.AKTO_GUARDRAILS.fetch(
        new Request("http://internal/api/validate/request-only", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(validationRequest),
          signal: controller.signal,
        })
      );

      clearTimeout(timeoutId);

      if (!response.ok) {
        console.error("[Blocking] Validation request failed:", response.status);
        return {
          allowed: true,
          shouldBlock: false,
          action: "ALLOW",
        };
      }

      const result = (await response.json()) as ValidationResult;
      return result;
    } catch (error: any) {
      clearTimeout(timeoutId);
      if (error.name === "AbortError") {
        console.error("[Blocking] Validation timeout, failing open");
      } else {
        console.error("[Blocking] Validation error:", error);
      }
      return {
        allowed: true,
        shouldBlock: false,
        action: "ALLOW",
      };
    }
  } catch (error) {
    console.error("[Blocking] Validation setup error:", error);
    return {
      allowed: true,
      shouldBlock: false,
      action: "ALLOW",
    };
  }
}

export async function validateResponse(
  requestPayload: string,
  responsePayload: string,
  request: Request,
  responseStatus: number,
  env: ProxyEnv
): Promise<ValidationResult> {
  if (!env.AKTO_GUARDRAILS) {
    console.log("[Blocking] No guardrails binding, skipping validation");
    return {
      allowed: true,
      shouldBlock: false,
      action: "ALLOW",
    };
  }

  try {
    const url = new URL(request.url);
    const validationRequest = {
      batchData: [
        {
          path: url.pathname,
          method: request.method,
          requestHeaders: JSON.stringify(Object.fromEntries(request.headers)),
          responseHeaders: "",
          requestPayload,
          responsePayload,
          ip: request.headers.get("cf-connecting-ip") || "127.0.0.1",
          time: Math.floor(Date.now() / 1000).toString(),
          statusCode: responseStatus.toString(),
          type: "HTTP/1.1",
          status: "OK",
          akto_account_id: "1000000",
          akto_vxlan_id: "0",
          is_pending: "false",
          source: "VALIDATION",
        },
      ],
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    try {
      const response = await env.AKTO_GUARDRAILS.fetch(
        new Request("http://internal/api/ingestData", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(validationRequest),
          signal: controller.signal,
        })
      );

      clearTimeout(timeoutId);

      if (!response.ok) {
        console.error("[Blocking] Response validation failed:", response.status);
        return {
          allowed: true,
          shouldBlock: false,
          action: "ALLOW",
        };
      }

      const result = await response.json();

      if (result.results && result.results.length > 0) {
        const validationResult = result.results[0];
        const responseBlocked = !validationResult.responseAllowed;

        return {
          allowed: !responseBlocked,
          shouldBlock: responseBlocked,
          action: responseBlocked ? "BLOCK" : "ALLOW",
          reason: responseBlocked
            ? "Response blocked by guardrails"
            : undefined,
        };
      }

      return {
        allowed: true,
        shouldBlock: false,
        action: "ALLOW",
      };
    } catch (error: any) {
      clearTimeout(timeoutId);
      if (error.name === "AbortError") {
        console.error("[Blocking] Response validation timeout, failing open");
      } else {
        console.error("[Blocking] Response validation error:", error);
      }
      return {
        allowed: true,
        shouldBlock: false,
        action: "ALLOW",
      };
    }
  } catch (error) {
    console.error("[Blocking] Response validation setup error:", error);
    return {
      allowed: true,
      shouldBlock: false,
      action: "ALLOW",
    };
  }
}

export function createBlockedResponse(
  reason: string,
  metadata?: Record<string, any>,
  originalRequestId?: string | number
): Response {
  const errorResponse = {
    jsonrpc: "2.0",
    id: originalRequestId || null,
    error: {
      code: -32000,
      message: "Request blocked by security policy",
      data: {
        reason,
        timestamp: Math.floor(Date.now() / 1000),
        ...metadata,
      },
    },
  };

  return new Response(JSON.stringify(errorResponse), {
    status: 403,
    headers: {
      "Content-Type": "application/json",
      "X-Blocked-By": "Akto-Guardrails",
    },
  });
}

export function extractRequestId(payload: string): string | number | null {
  try {
    const parsed = JSON.parse(payload);
    return parsed.id || null;
  } catch {
    return null;
  }
}

export function buildLogEntry(
  request: Request,
  response: Response,
  reqBody: string,
  resBody: string,
  blocked: boolean = false,
  blockedAt?: "request" | "response"
): LogEntry {
  const url = new URL(request.url);

  const metadata: Record<string, any> = {};
  if (blocked) {
    metadata.blocked = true;
    metadata.blockedAt = blockedAt;
    metadata.blockedTime = Math.floor(Date.now() / 1000);
  }

  return {
    path: url.pathname,
    method: request.method,
    requestHeaders: JSON.stringify(Object.fromEntries(request.headers)),
    responseHeaders: JSON.stringify(Object.fromEntries(response.headers)),
    requestPayload: reqBody,
    responsePayload: resBody,
    ip: request.headers.get("cf-connecting-ip") || "127.0.0.1",
    time: Math.floor(Date.now() / 1000).toString(),
    statusCode: response.status.toString(),
    type: "HTTP/1.1",
    status: response.statusText || "OK",
    akto_account_id: "1000000",
    akto_vxlan_id: "0",
    is_pending: "false",
    source: blocked ? "BLOCKED" : "MIRRORING",
    tag: JSON.stringify({ service: "cloudflare", mode: "blocked" }),
    metadata: Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : undefined,
  };
}

export async function ingestLogEntry(logEntry: LogEntry, env: ProxyEnv): Promise<void> {
  try {
    if (env.AKTO_INGEST_GUARDRAILS) {
      const response = await env.AKTO_INGEST_GUARDRAILS.fetch(
        new Request("http://internal/api/ingestData", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ batchData: [logEntry] }),
        })
      );

      if (response.ok) {
        console.log("[Blocking] Log sent to guardrails service");
      } else {
        console.error("[Blocking] Failed to send log:", response.status);
      }
    } else if (env.DATA_INGESTION_URL) {
      const response = await fetch(env.DATA_INGESTION_URL + "/api/ingestData", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ batchData: [logEntry] }),
      });

      if (response.ok) {
        console.log("[Blocking] Log sent to ingestion URL");
      } else {
        console.error("[Blocking] Failed to send log:", response.status);
      }
    } else {
      console.warn("[Blocking] No ingestion service configured");
    }
  } catch (error) {
    console.error("[Blocking] Ingestion error:", error);
  }
}
