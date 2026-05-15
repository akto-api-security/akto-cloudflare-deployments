import { Container } from "@cloudflare/containers";
import { Hono } from "hono";
import { handleBatchValidation } from "./handlers/validation-handler";
import type { IngestDataBatch } from "./types/mcp";
import { replicateRequest } from "./utils/request-utils";

export class AktoMiniRuntimeServiceContainer extends Container {
  defaultPort = 8080;
  sleepAfter = "2h";
  requiredPorts = [8080];

  private workerEnv: any;

  constructor(state: DurableObjectState, env: any) {
    super(state, env);
    this.workerEnv = env;
  }

  override async fetch(request: Request): Promise<Response> {
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
      await this.startAndWaitForPorts(this.defaultPort, {
        portReadyTimeoutMS: 120000,
        instanceGetTimeoutMS: 120000,
      });
      return await super.fetch(request);
    } catch (error) {
      console.error("[Container] Fetch error:", error);
      return new Response(JSON.stringify({ error: "Container startup failed", details: String(error) }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  override onStart() { console.log("[Container] Started"); }
  override onStop()  { console.log("[Container] Stopped"); }
  override onError(error: unknown) { console.log("[Container] Error:", error); }
}

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

function forwardToContainer(
  request: Request,
  env: { AKTO_MINI_RUNTIME_SERVICE_CONTAINER: DurableObjectNamespace<AktoMiniRuntimeServiceContainer> }
): Promise<Response> {
  const containerId = env.AKTO_MINI_RUNTIME_SERVICE_CONTAINER.idFromName("main");
  const container = env.AKTO_MINI_RUNTIME_SERVICE_CONTAINER.get(containerId);
  return container.fetch(request);
}

function getEnvConfig(env: {
  DATABASE_ABSTRACTOR_SERVICE_URL: string;
  DATABASE_ABSTRACTOR_SERVICE_TOKEN: string;
  THREAT_BACKEND_URL: string;
  THREAT_BACKEND_TOKEN: string;
}) {
  return {
    dbUrl:    env.DATABASE_ABSTRACTOR_SERVICE_URL  || "https://cyborg.akto.io",
    dbToken:  env.DATABASE_ABSTRACTOR_SERVICE_TOKEN || "",
    tbsHost:  env.THREAT_BACKEND_URL               || "https://tbs.akto.io",
    tbsToken: env.THREAT_BACKEND_TOKEN             || "",
  };
}

// ─── Health ───────────────────────────────────────────────────────────────────

app.get("/health", (c) => c.json({ success: true, status: "healthy" }));

// ─── /api/http-proxy ──────────────────────────────────────────────────────────
// Unified endpoint used by akto-cloudflare-proxy and the Kong plugin.
//
// Query params:
//   guardrails=true        run guardrails validation (requires ENABLE_MCP_GUARDRAILS=true)
//   ingest_data=true       forward traffic to the mini-runtime container
//   akto_connector=<name>  connector identifier (kong | cloudflare | …)
//
// Body:   single IngestDataBatch item (flat JSON, not wrapped in batchData)
// Returns { data: { guardrailsResult: { Allowed: bool, Reason: string } } }

app.post("/api/http-proxy", async (c) => {
  const guardrails = c.req.query("guardrails") === "true";
  const ingestData = c.req.query("ingest_data") === "true";

  const batchItem = await c.req.json<IngestDataBatch>();
  const { dbUrl, dbToken, tbsHost, tbsToken } = getEnvConfig(c.env);

  let guardrailsAllowed = true;
  let guardrailsReason  = "";

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

    const r = results[0];
    if (r && !r.requestAllowed) {
      guardrailsAllowed = false;
      guardrailsReason  = r.requestReason  || "Request blocked by guardrails";
    } else if (r && !r.responseAllowed) {
      guardrailsAllowed = false;
      guardrailsReason  = r.responseReason || "Response blocked by guardrails";
    }
  }

  if (ingestData) {
    await forwardToContainer(
      new Request("https://akto-ingest/api/ingestData", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ batchData: [batchItem] }),
      }),
      c.env
    );
  }

  return c.json({ data: { guardrailsResult: { Allowed: guardrailsAllowed, Reason: guardrailsReason } } });
});

// ─── /api/ingestData ──────────────────────────────────────────────────────────
// Async ingestion endpoint called by akto-cloudflare-proxy after the upstream
// response is complete. Forwards traffic to the mini-runtime container for API
// discovery; also runs guardrails validation when ENABLE_MCP_GUARDRAILS=true.
//
// Body: { batchData: IngestDataBatch[] }

app.post("/api/ingestData", async (c) => {
  const mcpGuardrailsEnabled = c.env.ENABLE_MCP_GUARDRAILS === "true";

  if (mcpGuardrailsEnabled) {
    const [requestForGuardrails, requestForContainer] = await replicateRequest(c.req.raw);
    const { dbUrl, dbToken, tbsHost, tbsToken } = getEnvConfig(c.env);

    const requestBody = await requestForGuardrails.json() as any;
    const batchData: IngestDataBatch[] = requestBody.batchData || [];

    const [results] = await Promise.all([
      handleBatchValidation(batchData, {
        dbUrl,
        dbToken,
        modelExecutorBinding: c.env.AKTO_GUARDRAILS_EXECUTOR,
        tbsHost,
        tbsToken,
        executionCtx: c.executionCtx,
        rateLimitKV: c.env.AKTO_GUARDRAILS_RATE_LIMIT_KV,
      }),
      forwardToContainer(requestForContainer, c.env),
    ]);

    return c.json({ success: true, result: "SUCCESS", results });
  }

  await forwardToContainer(c.req.raw, c.env);
  return c.json({ success: true, result: "SUCCESS" });
});

export default app;
