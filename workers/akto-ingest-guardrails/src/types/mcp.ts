// Matches IngestDataBatch from Go: apps/guardrails-service/container/src/models/payload.go
export interface IngestDataBatch {
  path: string;
  requestHeaders?: string;
  responseHeaders?: string;
  method: string;
  requestPayload?: string;
  responsePayload?: string;
  ip?: string;
  destIp?: string;
  time?: string;
  statusCode?: string;
  type?: string;
  status?: string;
  akto_account_id?: string;
  akto_vxlan_id?: number;
  is_pending?: string;
  source?: string;
  tag?: string;
  metadata?: string;
  contextSource?: string;
  direction?: null;
  process_id?: null;
  socket_id?: null;
  daemonset_id?: null;
  enabled_graph?: null;
}
