import { Container } from "@cloudflare/containers";

type Env = {
  readonly AKTO_GUARDRAIL_EXECUTOR_CONTAINER_CF: DurableObjectNamespace<AktoGuardrailExecutorContainerCf>;
};

export class AktoGuardrailExecutorContainerCf extends Container {
  defaultPort = 8092;
  sleepAfter = "2h";

  override async fetch(request: Request): Promise<Response> {
    this.envVars = {
      PYTHONUNBUFFERED: "1",
      PORT: "8092",
      HF_HOME: "/app/.cache/huggingface",
    };

    try {
      await this.startAndWaitForPorts(this.defaultPort, {
        portReadyTimeoutMS: 300000,
        instanceGetTimeoutMS: 120000,
      });
      return await super.fetch(request);
    } catch (error) {
      console.error("[AgentGuardExecutor] Fetch error:", error);
      return new Response(
        JSON.stringify({ error: "Container startup failed", details: String(error) }),
        { status: 503, headers: { "Content-Type": "application/json" } }
      );
    }
  }

  override onStart() { console.log("[AgentGuardExecutor] Started"); }
  override onStop()  { console.log("[AgentGuardExecutor] Stopped"); }
  override onError(error: unknown) { console.error("[AgentGuardExecutor] Error:", error); }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const id = env.AKTO_GUARDRAIL_EXECUTOR_CONTAINER_CF.idFromName("main");
    return env.AKTO_GUARDRAIL_EXECUTOR_CONTAINER_CF.get(id).fetch(request);
  },
};
