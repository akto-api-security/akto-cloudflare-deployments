import { Container } from "@cloudflare/containers";

type Environment = {
  readonly AKTO_MINI_RUNTIME_CONTAINER: DurableObjectNamespace<AktoMiniRuntimeContainer>;
  readonly DATABASE_ABSTRACTOR_SERVICE_URL: string;
  readonly DATABASE_ABSTRACTOR_SERVICE_TOKEN: string;
  readonly AKTO_INSTANCE_TYPE?: string;
  readonly RUNTIME_MODE?: string;
  readonly MINI_RUNTIME_NAME?: string;
};

export class AktoMiniRuntimeContainer extends Container {
  defaultPort = 8001;
  sleepAfter = "2h";

  private workerEnv: Environment;

  constructor(state: any, env: Environment) {
    super(state, env);
    this.workerEnv = env;
  }

  override async fetch(request: Request): Promise<Response> {
    this.envVars = {
      DATABASE_ABSTRACTOR_SERVICE_URL: this.workerEnv.DATABASE_ABSTRACTOR_SERVICE_URL,
      DATABASE_ABSTRACTOR_SERVICE_TOKEN: this.workerEnv.DATABASE_ABSTRACTOR_SERVICE_TOKEN,
      AKTO_INSTANCE_TYPE: this.workerEnv.AKTO_INSTANCE_TYPE ?? "RUNTIME",
      RUNTIME_MODE: this.workerEnv.RUNTIME_MODE ?? "hybrid",
      MINI_RUNTIME_NAME: this.workerEnv.MINI_RUNTIME_NAME ?? "mini-runtime-cf",
      AKTO_TRAFFIC_BATCH_SIZE: "100",
      AKTO_TRAFFIC_BATCH_TIME_SECS: "10",
      USE_HOSTNAME: "true",
    };

    try {
      await this.startAndWaitForPorts(this.defaultPort, {
        portReadyTimeoutMS: 120000,
        instanceGetTimeoutMS: 120000,
      });
      return await super.fetch(request);
    } catch (error) {
      console.error("[Mini-Runtime Container] Fetch error:", error);
      return new Response(
        JSON.stringify({ error: "Container startup failed", details: String(error) }),
        { status: 503, headers: { "Content-Type": "application/json" } }
      );
    }
  }

  override onStart() { console.log("[Mini-Runtime Container] Started"); }
  override onStop()  { console.log("[Mini-Runtime Container] Stopped"); }
  override onError(error: unknown) { console.error("[Mini-Runtime Container] Error:", error); }
}

export default {
  async fetch(request: Request, env: Environment, ctx: ExecutionContext): Promise<Response> {
    try {
      const containerId = env.AKTO_MINI_RUNTIME_CONTAINER.idFromName("main");
      const container = env.AKTO_MINI_RUNTIME_CONTAINER.get(containerId);
      return await container.fetch(request);
    } catch (error) {
      console.error("[Mini-Runtime] Error:", error);
      return new Response(
        JSON.stringify({ error: "Mini-runtime unavailable", details: String(error) }),
        { status: 503, headers: { "Content-Type": "application/json" } }
      );
    }
  },
};
