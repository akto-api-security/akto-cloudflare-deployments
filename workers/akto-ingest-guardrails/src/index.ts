import { Container, loadBalance, getContainer } from "@cloudflare/containers";
import { Hono } from "hono";
import { fetchGuardrailPolicies, fetchMcpAuditInfo } from "./services/policy-manager";
import {
  handleBatchValidation,
  handleRequestValidation,
  handleResponseValidation,
} from "./handlers/validation-handler";
import type {
  IngestDataBatch,
} from "./types/mcp";
import { replicateRequest } from "./utils/request-utils";

export class AktoMiniRuntimeServiceContainer extends Container {
  // Port the container listens on (default: 8080)
  defaultPort = 8080;
  // Time before container sleeps due to inactivity (default: 30s)
  sleepAfter = "2h";
  // Required ports to wait for before accepting requests
  requiredPorts = [8080];

  private workerEnv: any;

  constructor(state: DurableObjectState, env: any) {
    super(state, env);
    this.workerEnv = env;
  }

  override async fetch(request: Request): Promise<Response> {
    // Set env vars dynamically from Worker env before starting
    this.envVars = {
      AKTO_LOG_LEVEL: "DEBUG",
      DATABASE_ABSTRACTOR_SERVICE_URL: this.workerEnv.DATABASE_ABSTRACTOR_SERVICE_URL || "https://cyborg.akto.io",
      DATABASE_ABSTRACTOR_SERVICE_TOKEN: this.workerEnv.DATABASE_ABSTRACTOR_SERVICE_TOKEN || "",
      AKTO_TRAFFIC_QUEUE_THRESHOLD: "100",
      AKTO_INACTIVE_QUEUE_PROCESSING_TIME: "5000",
      AKTO_TRAFFIC_PROCESSING_JOB_INTERVAL: "10",
      AKTO_CONFIG_NAME: "STAGING",
      RUNTIME_MODE: "HYBRID",
    };

    try {
      // Start container and wait for ports with extended timeout for cold starts
      await this.startAndWaitForPorts(this.defaultPort, {
        portReadyTimeoutMS: 120000, // 2 minutes for cold start
        instanceGetTimeoutMS: 120000,
      });

      // Forward request to container
      return await super.fetch(request);
    } catch (error) {
      console.error("[Container] Fetch error:", error);
      return new Response(JSON.stringify({ error: "Container startup failed", details: String(error) }), {
        status: 503,
        headers: { "Content-Type": "application/json" }
      });
    }
  }

  // Optional lifecycle hooks
  override onStart() {
    console.log("[Container] Successfully started");
  }

  override onStop() {
    console.log("[Container] Successfully shut down");
  }

  override onError(error: unknown) {
    console.log("[Container] Error:", error);
  }

}

// Create Hono app with proper typing for Cloudflare Workers
const app = new Hono<{
  Bindings: {
    AKTO_MINI_RUNTIME_SERVICE_CONTAINER: DurableObjectNamespace<AktoMiniRuntimeServiceContainer>;
    AKTO_GUARDRAILS_EXECUTOR: Fetcher;
    DATABASE_ABSTRACTOR_SERVICE_URL: string;
    DATABASE_ABSTRACTOR_SERVICE_TOKEN: string;
    THREAT_BACKEND_URL: string;
    THREAT_BACKEND_TOKEN: string;
    ENABLE_MCP_GUARDRAILS: string;
    AKTO_GUARDRAILS_RATE_LIMIT_KV: KVNamespace;
  };
}>();

/**
 * Forward request to container (env vars are set dynamically in Container.fetch())
 */
async function forwardToContainer(
  request: Request,
  env: {
    AKTO_MINI_RUNTIME_SERVICE_CONTAINER: DurableObjectNamespace<AktoMiniRuntimeServiceContainer>;
  }
): Promise<Response> {
  // Get container instance
  const containerId = env.AKTO_MINI_RUNTIME_SERVICE_CONTAINER.idFromName("main");
  const container = env.AKTO_MINI_RUNTIME_SERVICE_CONTAINER.get(containerId);

  // Forward request - env vars are set in the Container's fetch() override
  return await container.fetch(request);
}

/**
 * Run MCP guardrails validation on batch data
 */
async function runMcpGuardrails(
  request: Request,
  env: {
    DATABASE_ABSTRACTOR_SERVICE_URL: string;
    DATABASE_ABSTRACTOR_SERVICE_TOKEN: string;
    AKTO_GUARDRAILS_EXECUTOR: Fetcher;
    THREAT_BACKEND_URL: string;
    THREAT_BACKEND_TOKEN: string;
    AKTO_GUARDRAILS_RATE_LIMIT_KV?: KVNamespace;
  },
  executionCtx: ExecutionContext
) {
  // Parse request body to extract batch data
  const requestBody = await request.json() as any;
  const batchData: IngestDataBatch[] = requestBody.batchData || [];

  return await handleBatchValidation(batchData, {
    dbUrl: env.DATABASE_ABSTRACTOR_SERVICE_URL || "https://cyborg.akto.io",
    dbToken: env.DATABASE_ABSTRACTOR_SERVICE_TOKEN || "",
    modelExecutorBinding: env.AKTO_GUARDRAILS_EXECUTOR,
    tbsHost: env.THREAT_BACKEND_URL || "https://tbs.akto.io",
    tbsToken: env.THREAT_BACKEND_TOKEN || "",
    executionCtx,
    rateLimitKV: env.AKTO_GUARDRAILS_RATE_LIMIT_KV,
  });
}


// Home route with available endpoints
app.get("/", (c) => {
  return c.text(
    "Available endpoints:\n" +
      "GET /container/<ID> - Start a container for each ID with a 2m timeout\n" +
      "GET /lb - Load balance requests over multiple containers\n" +
      "GET /error - Start a container that errors (demonstrates error handling)\n" +
      "GET /singleton - Get a single specific container instance",
  );
});

// Route requests to a specific container using the container ID
app.get("/container/:id", async (c) => {
  const id = c.req.param("id");
  const containerId = c.env.AKTO_MINI_RUNTIME_SERVICE_CONTAINER.idFromName(`/container/${id}`);
  const container = c.env.AKTO_MINI_RUNTIME_SERVICE_CONTAINER.get(containerId);
  return await container.fetch(c.req.raw);
});

// Demonstrate error handling - this route forces a panic in the container
app.get("/error", async (c) => {
  const container = getContainer(c.env.AKTO_MINI_RUNTIME_SERVICE_CONTAINER, "error-test");
  return await container.fetch(c.req.raw);
});

// Load balance requests across multiple containers
app.get("/lb", async (c) => {
  const container = await loadBalance(c.env.AKTO_MINI_RUNTIME_SERVICE_CONTAINER, 3);
  return await container.fetch(c.req.raw);
});

// Kong-compatible unified endpoint used by akto-cloudflare-proxy and Kong plugin.
// Query params:
//   guardrails=true        — run guardrails validation (controlled by ENABLE_MCP_GUARDRAILS)
//   ingest_data=true       — forward traffic to mini-runtime container
//   akto_connector=<name>  — source identifier (informational)
// Body: single IngestDataBatch item (flat, not wrapped in batchData)
// Response: { data: { guardrailsResult: { Allowed: bool, Reason: string } } }
app.post("/api/http-proxy", async (c) => {
  const guardrails = c.req.query("guardrails") === "true";
  const ingestData = c.req.query("ingest_data") === "true";

  const batchItem = await c.req.json<IngestDataBatch>();

  const dbUrl = c.env.DATABASE_ABSTRACTOR_SERVICE_URL || "https://cyborg.akto.io";
  const dbToken = c.env.DATABASE_ABSTRACTOR_SERVICE_TOKEN || "";
  const tbsHost = c.env.THREAT_BACKEND_URL || "https://tbs.akto.io";
  const tbsToken = c.env.THREAT_BACKEND_TOKEN || "";

  let guardrailsAllowed = true;
  let guardrailsReason = "";

  if (c.env.ENABLE_MCP_GUARDRAILS === "true" && guardrails) {
    const results = await handleBatchValidation([batchItem], {
      dbUrl,
      dbToken,
      modelExecutorBinding: c.env.AKTO_GUARDRAILS_EXECUTOR,
      tbsHost,
      tbsToken,
      executionCtx: c.executionCtx,
      rateLimitKV: c.env.AKTO_GUARDRAILS_RATE_LIMIT_KV,
    });

    const result = results[0];
    if (result && !result.requestAllowed) {
      guardrailsAllowed = false;
      guardrailsReason = result.requestReason || "Request blocked by guardrails";
    } else if (result && !result.responseAllowed) {
      guardrailsAllowed = false;
      guardrailsReason = result.responseReason || "Response blocked by guardrails";
    }
  }

  if (ingestData) {
    const ingestReq = new Request("https://akto-ingest/api/ingestData", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ batchData: [batchItem] }),
    });
    await forwardToContainer(ingestReq, c.env);
  }

  return c.json({
    data: {
      guardrailsResult: {
        Allowed: guardrailsAllowed,
        Reason: guardrailsReason,
      },
    },
  });
});

// Main data ingestion endpoint with validation
app.post("/api/ingestData", async (c) => {
  // Check if MCP guardrails are enabled via feature flag
  const mcpGuardrailsEnabled = c.env.ENABLE_MCP_GUARDRAILS === "true";

  if (mcpGuardrailsEnabled) {
    // Replicate the request to send it to two different places
    const [requestForGuardrails, requestForContainer] = await replicateRequest(c.req.raw);

    // Run validation and container ingestion in parallel
    const [results] = await Promise.all([
      runMcpGuardrails(requestForGuardrails, c.env, c.executionCtx),
      forwardToContainer(requestForContainer, c.env),
    ]);

    return c.json({
      success: true,
      result: "SUCCESS",
      results,
    });
  } else {
    // Only forward to container without validation
    await forwardToContainer(c.req.raw, c.env);

    return c.json({
      success: true,
      result: "SUCCESS",
      message: "Data ingested (MCP guardrails disabled)",
    });
  }
});

// Health check endpoint
app.get("/health", (c) => {
  return c.json({ success: true, status: "healthy" });
});

// Validate single request endpoint
app.post("/api/validate/request", async (c) => {
  const body = await c.req.json<{
    payload: string;
    path?: string;
    method?: string;
    ip?: string;
    requestHeaders?: string;
  }>();

  const dbUrl = c.env.DATABASE_ABSTRACTOR_SERVICE_URL || "https://cyborg.akto.io";
  const dbToken = c.env.DATABASE_ABSTRACTOR_SERVICE_TOKEN || "";

  const [policies, auditPolicies] = await Promise.all([
    fetchGuardrailPolicies(dbUrl, dbToken),
    fetchMcpAuditInfo(dbUrl, dbToken),
  ]);

  const hasAuditRules = Object.keys(auditPolicies).length > 0;
  const tbsHost = c.env.THREAT_BACKEND_URL || "https://tbs.akto.io";
  const tbsToken = c.env.THREAT_BACKEND_TOKEN || "";

  const parsedReqHeaders = body.requestHeaders ? JSON.parse(body.requestHeaders) : {};
  const valCtx = {
    ip: body.ip,
    endpoint: body.path,
    method: body.method,
    requestHeaders: parsedReqHeaders,
  };

  const result = await handleRequestValidation(
    body.payload,
    valCtx,
    policies,
    auditPolicies,
    hasAuditRules,
    c.env.AKTO_GUARDRAILS_EXECUTOR,
    tbsHost,
    tbsToken,
    c.executionCtx,
    dbUrl,
    dbToken,
    c.env.AKTO_GUARDRAILS_RATE_LIMIT_KV
  );

  return c.json(result);
});

// Validate single response endpoint
app.post("/api/validate/response", async (c) => {
  const body = await c.req.json<{
    payload: string;
    path?: string;
    method?: string;
    ip?: string;
    responseHeaders?: string;
  }>();

  const dbUrl = c.env.DATABASE_ABSTRACTOR_SERVICE_URL || "https://cyborg.akto.io";
  const dbToken = c.env.DATABASE_ABSTRACTOR_SERVICE_TOKEN || "";

  const policies = await fetchGuardrailPolicies(dbUrl, dbToken);
  const tbsHost = c.env.THREAT_BACKEND_URL || "https://tbs.akto.io";
  const tbsToken = c.env.THREAT_BACKEND_TOKEN || "";

  const parsedRespHeaders = body.responseHeaders ? JSON.parse(body.responseHeaders) : {};
  const valCtx = {
    ip: body.ip,
    endpoint: body.path,
    method: body.method,
    responseHeaders: parsedRespHeaders,
  };

  const result = await handleResponseValidation(
    body.payload,
    valCtx,
    policies,
    c.env.AKTO_GUARDRAILS_EXECUTOR,
    tbsHost,
    tbsToken,
    c.executionCtx,
    dbUrl,
    dbToken,
    c.env.AKTO_GUARDRAILS_RATE_LIMIT_KV
  );

  return c.json(result);
});

export default app;
