export type GuardrailsMode = "async" | "blocked";

export interface ProxyEnv {
  MCP: Fetcher;
  AKTO_GUARDRAILS?: Fetcher;
  AKTO_INGEST_GUARDRAILS?: Fetcher;
  GUARDRAILS_MODE?: string;
  DATA_INGESTION_URL?: string;
}

export interface ValidationResult {
  allowed: boolean;
  shouldBlock: boolean;
  action: "ALLOW" | "BLOCK";
  reason?: string;
  metadata?: Record<string, any>;
  blockedResponse?: Record<string, any>;
}

export interface LogEntry {
  path: string;
  method: string;
  requestHeaders: string;
  responseHeaders: string;
  requestPayload: string;
  responsePayload: string;
  ip: string;
  time: string;
  statusCode: string;
  type: string;
  status: string;
  akto_account_id: string;
  akto_vxlan_id: string;
  is_pending: string;
  source: string;
  tag: string;
  metadata?: string;
}
