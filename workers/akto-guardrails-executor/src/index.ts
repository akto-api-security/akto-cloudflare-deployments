import { Container } from "@cloudflare/containers";
import { Hono } from "hono";

type Environment = {
  readonly AKTO_GUARDRAILS_EXECUTOR_CONTAINER: DurableObjectNamespace<AktoGuardrailsExecutorContainer>;
  readonly DATABASE_ABSTRACTOR_SERVICE_URL: string;
  readonly DATABASE_ABSTRACTOR_SERVICE_TOKEN: string;
  readonly AGENT_GUARD_ENGINE_URL?: string;
  readonly LOG_LEVEL?: string;
};

export class AktoGuardrailsExecutorContainer extends Container {
  defaultPort = 8080;
  sleepAfter = "2h";

  private workerEnv: any;

  constructor(state: any, env: any) {
    super(state, env);
    this.workerEnv = env;
  }

  override async fetch(request: Request): Promise<Response> {
    this.envVars = {
      DATABASE_ABSTRACTOR_SERVICE_URL: this.workerEnv.DATABASE_ABSTRACTOR_SERVICE_URL,
      DATABASE_ABSTRACTOR_SERVICE_TOKEN: this.workerEnv.DATABASE_ABSTRACTOR_SERVICE_TOKEN || "",
      AGENT_GUARD_ENGINE_URL: this.workerEnv.AGENT_GUARD_ENGINE_URL || "",
      LOG_LEVEL: this.workerEnv.LOG_LEVEL || "info",
    };

    try {
      await this.startAndWaitForPorts(this.defaultPort, {
        portReadyTimeoutMS: 120000,
        instanceGetTimeoutMS: 120000,
      });
      return await super.fetch(request);
    } catch (error) {
      console.error("[Guardrails Container] Fetch error:", error);
      return new Response(JSON.stringify({ error: "Container startup failed", details: String(error) }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  override onStart() { console.log("[Guardrails Container] Started"); }
  override onStop()  { console.log("[Guardrails Container] Stopped"); }
  override onError(error: unknown) { console.error("[Guardrails Container] Error:", error); }
}

const app = new Hono<{ Bindings: Environment }>();

app.get("/health", (c) => c.json({ status: "healthy", timestamp: new Date().toISOString() }));

export default {
  async fetch(request: Request, env: Environment, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return app.fetch(request, env, ctx);
    }

    // Forward all requests to the guardrails-service container (single instance)
    try {
      const containerId = env.AKTO_GUARDRAILS_EXECUTOR_CONTAINER.idFromName("main");
      const container = env.AKTO_GUARDRAILS_EXECUTOR_CONTAINER.get(containerId);
      return await container.fetch(request);
    } catch (error) {
      console.error("[Guardrails Executor] Error:", error);
      return new Response(JSON.stringify({ error: "Guardrails service unavailable", details: String(error) }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }
  },
};
