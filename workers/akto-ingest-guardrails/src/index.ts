import { Container } from "@cloudflare/containers";
import { Hono } from "hono";

export class AktoDataIngestionContainer extends Container {
  defaultPort = 8080;
  sleepAfter = "2h";

  override async fetch(request: Request): Promise<Response> {
    this.envVars = {
      AKTO_TRAFFIC_BATCH_SIZE: "100",
      AKTO_TRAFFIC_BATCH_TIME_SECS: "10",
    };

    try {
      await this.startAndWaitForPorts(this.defaultPort, {
        portReadyTimeoutMS: 120000,
        instanceGetTimeoutMS: 120000,
      });
      return await super.fetch(request);
    } catch (error) {
      console.error("[Data-Ingestion Container] Fetch error:", error);
      return new Response(JSON.stringify({ error: "Container startup failed", details: String(error) }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  override onStart() { console.log("[Data-Ingestion Container] Started"); }
  override onStop()  { console.log("[Data-Ingestion Container] Stopped"); }
  override onError(error: unknown) { console.error("[Data-Ingestion Container] Error:", error); }
}

type Env = {
  AKTO_DATA_INGESTION_CONTAINER: DurableObjectNamespace<AktoDataIngestionContainer>;
  AKTO_GUARDRAILS_EXECUTOR: Fetcher;
  AKTO_MINI_RUNTIME_WORKER: Fetcher;
  ENABLE_MCP_GUARDRAILS: string;
};

const app = new Hono<{ Bindings: Env }>();

function forwardToDataIngestion(request: Request, env: Env): Promise<Response> {
  const id = env.AKTO_DATA_INGESTION_CONTAINER.idFromName("main");
  return env.AKTO_DATA_INGESTION_CONTAINER.get(id).fetch(request);
}

function forwardToMiniRuntime(body: string, env: Env): Promise<Response> {
  return env.AKTO_MINI_RUNTIME_WORKER.fetch(
    new Request("https://akto-mini-runtime/utility/ingestTraffic", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    })
  );
}

app.get("/health", (c) => c.json({ success: true, status: "healthy" }));

// ─── /api/http-proxy ──────────────────────────────────────────────────────────
// Called by akto-cloudflare-proxy for every intercepted request.
// Query params:
//   guardrails=true     validate via akto-guardrails-executor
//   ingest_data=true    ingest via data-ingestion container + forward to mini-runtime

app.post("/api/http-proxy", async (c) => {
  const guardrails = c.req.query("guardrails") === "true";
  const ingestData = c.req.query("ingest_data") === "true";

  const bodyText = await c.req.text();

  let guardrailsAllowed = true;
  let guardrailsReason  = "";

  if (c.env.ENABLE_MCP_GUARDRAILS === "true" && guardrails) {
    try {
      const res = await c.env.AKTO_GUARDRAILS_EXECUTOR.fetch(
        new Request("https://guardrails-executor/api/validate/request", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: bodyText,
        })
      );
      const text = await res.text();
      try {
        const json = JSON.parse(text) as any;
        guardrailsAllowed = json?.Allowed ?? true;
        guardrailsReason  = json?.Reason  ?? "";
      } catch {
        console.error("[Guardrails] Non-JSON response:", text.slice(0, 200));
      }
    } catch (error) {
      console.error("[Guardrails] Executor error:", error);
    }
  }

  if (ingestData) {
    const batchBody = JSON.stringify({ batchData: [JSON.parse(bodyText)] });
    await Promise.all([
      forwardToDataIngestion(
        new Request("https://akto-ingest/api/ingestData", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: batchBody,
        }),
        c.env
      ).catch((e) => console.error("[Ingest] Data-ingestion error:", e)),
      forwardToMiniRuntime(bodyText, c.env)
        .catch((e) => console.error("[Ingest] Mini-runtime error:", e)),
    ]);
  }

  return c.json({ data: { guardrailsResult: { Allowed: guardrailsAllowed, Reason: guardrailsReason } } });
});

// ─── /api/ingestData ──────────────────────────────────────────────────────────
// Called by akto-cloudflare-proxy when guardrails are disabled.

app.post("/api/ingestData", async (c) => {
  const bodyText = await c.req.text();
  let miniRuntimeBody = bodyText;
  try {
    const parsed = JSON.parse(bodyText) as { batchData?: unknown[] };
    const items = parsed.batchData ?? [parsed];
    miniRuntimeBody = JSON.stringify(items.length === 1 ? items[0] : items);
  } catch { /* send as-is if not valid JSON */ }
  await Promise.all([
    forwardToDataIngestion(
      new Request("https://akto-ingest/api/ingestData", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: bodyText,
      }),
      c.env
    ).catch((e) => console.error("[Ingest] Data-ingestion error:", e)),
    forwardToMiniRuntime(miniRuntimeBody, c.env)
      .catch((e) => console.error("[Ingest] Mini-runtime error:", e)),
  ]);
  return c.json({ success: true, result: "SUCCESS" });
});

export default app;
