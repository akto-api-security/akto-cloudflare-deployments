// MCP Validation Types

export interface FilterRule {
  type: string;
  pattern?: string;
  action?: string;
  config?: FilterRuleConfig;
}

export interface FilterRuleConfig {
  [key: string]: any;
}

export const RATE_LIMIT_IDENTIFIER_TYPE = {
  IP: "ip",
  USER: "user",
  TOOL: "tool",
} as const;

export type RateLimitIdentifierType = typeof RATE_LIMIT_IDENTIFIER_TYPE[keyof typeof RATE_LIMIT_IDENTIFIER_TYPE];

export interface RateLimitConfig {
  enabled: boolean;
  limit: number;
  windowSeconds: number;
  identifierTypes: RateLimitIdentifierType[];
}

export interface PolicyFilters {
  requestPayload?: FilterRule[];
  responsePayload?: FilterRule[];
  rateLimit?: RateLimitConfig;
}

export interface Policy {
  id: string;
  name: string;
  active: boolean;
  action: string;
  filters: PolicyFilters;
}

export interface AuditPolicy {
  resourceName: string;
  [key: string]: any;
}

export interface ContentFiltering {
  harmfulCategories?: any;
  promptAttacks?: {
    level?: string;
  };
}

export interface DeniedTopic {
  topic: string;
  samplePhrases: string[];
}

export interface PIIType {
  type: string;
  behavior?: string; // "block" or "mask"
}

export interface RegexPatternType {
  pattern: string;
  action?: string;
}

export interface GuardrailsPolicy {
  id?: string;
  name?: string;
  active?: boolean;
  applyOnRequest?: boolean;
  applyOnResponse?: boolean;
  blockedMessage?: string;
  contentFiltering?: ContentFiltering;
  deniedTopics?: DeniedTopic[];
  piiTypes?: PIIType[];
  regexPatternsV2?: RegexPatternType[];
  rateLimit?: RateLimitConfig;
  description?: string;
}

export interface ValidationContext {
  ip?: string;
  destIP?: string;
  endpoint?: string;
  method?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  statusCode?: number;
  requestPayload?: string;
  responsePayload?: string;
  mcpServerName?: string;
  policies?: Policy[];
  auditPolicies?: Record<string, AuditPolicy>;
  hasAuditRules?: boolean;
  rateLimitPolicy?: RateLimitConfig; // Global rate limit policy
  executionCtx?: ExecutionContext;
}

export interface ValidationResult {
  allowed: boolean;
  modified: boolean;
  modifiedPayload?: string;
  reason?: string;
  metadata?: Record<string, any>;
  shouldBlock?: boolean;
  action?: "ALLOW" | "BLOCK";
  blockedResponse?: Record<string, any>;
}

export interface ProcessResult {
  isBlocked: boolean;
  blockedResponse?: Record<string, any>;
  parsedData?: Record<string, any>;
  modifiedPayload?: string;
  shouldForward: boolean;
}

export interface ScannerInfo {
  scanner_type: string;
  scanner_name: string;
  config: FilterRuleConfig;
}

export interface ScanResult {
  scanner_name: string;
  is_valid: boolean;
  risk_score: number;
  sanitized_text?: string;
  details?: Record<string, any>;
  execution_time_ms: number;
}

export interface ScanResponse {
  request_id?: string;
  total_time_ms: number;
  results: ScanResult[];
  failure_count: number;
  success_count: number;
}

export interface SingleScanRequest {
  text: string;
  scanner_type: string;
  scanner_name: string;
  config: FilterRuleConfig;
}

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
  akto_vxlan_id?: string;
  is_pending?: string;
  source?: string;
}

export interface ValidationRequest {
  batchData: IngestDataBatch[];
}

export interface ValidationResponse {
  success: boolean;
  result: string;
  results?: ValidationBatchResult[];
  errors?: string[];
}

export interface ValidationBatchResult {
  index: number;
  method: string;
  path: string;
  requestAllowed: boolean;
  requestModified: boolean;
  requestModifiedPayload?: string;
  requestReason?: string;
  requestError?: string;
  responseAllowed: boolean;
  responseModified: boolean;
  responseModifiedPayload?: string;
  responseReason?: string;
  responseError?: string;
}
