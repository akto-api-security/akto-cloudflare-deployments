import { MCPProcessor } from "../services/mcp-processor";
import { fetchGuardrailPolicies, fetchMcpAuditInfo, fetchRateLimitPolicy } from "../services/policy-manager";
import type {
  IngestDataBatch,
  ValidationBatchResult,
  Policy,
  AuditPolicy,
  ValidationContext,
  RateLimitConfig,
} from "../types/mcp";

/**
 * Handle batch validation of MCP requests/responses
 * Fetches policies if dbUrl and dbToken are provided, otherwise uses pre-fetched policies
 */
export async function handleBatchValidation(
  batchData: IngestDataBatch[],
  config: {
    // Option 1: Provide DB config to fetch policies
    dbUrl?: string;
    dbToken?: string;
    // Option 2: Provide pre-fetched policies
    policies?: Policy[];
    auditPolicies?: Record<string, AuditPolicy>;
    hasAuditRules?: boolean;
    rateLimitPolicy?: RateLimitConfig;
    // Common
    modelExecutorBinding: Fetcher;
    tbsHost: string;
    tbsToken: string;
    executionCtx?: ExecutionContext;
    rateLimitKV?: KVNamespace;
  }
): Promise<ValidationBatchResult[]> {
  let policies: Policy[];
  let auditPolicies: Record<string, AuditPolicy>;
  let hasAuditRules: boolean;
  let rateLimitPolicy: RateLimitConfig | undefined;

  // Fetch policies if DB config provided
  if (config.dbUrl && config.dbToken) {
    const [fetchedPolicies, fetchedAuditPolicies, fetchedRateLimitPolicy] = await Promise.all([
      fetchGuardrailPolicies(config.dbUrl, config.dbToken),
      fetchMcpAuditInfo(config.dbUrl, config.dbToken),
      fetchRateLimitPolicy(config.tbsHost, config.tbsToken),
    ]);
    policies = fetchedPolicies;
    auditPolicies = fetchedAuditPolicies;
    hasAuditRules = Object.keys(auditPolicies).length > 0;
    rateLimitPolicy = fetchedRateLimitPolicy;
  } else {
    // Use pre-fetched policies
    policies = config.policies || [];
    auditPolicies = config.auditPolicies || {};
    hasAuditRules = config.hasAuditRules ?? false;
    rateLimitPolicy = config.rateLimitPolicy;
  }

  const processor = new MCPProcessor(
    config.modelExecutorBinding,
    config.tbsHost,
    config.tbsToken,
    false,
    config.executionCtx,
    config.dbUrl,
    config.dbToken,
    config.rateLimitKV
  );
  const results: ValidationBatchResult[] = [];

  for (let i = 0; i < batchData.length; i++) {
    const data = batchData[i];
    const result: ValidationBatchResult = {
      index: i,
      method: data.method,
      path: data.path,
      requestAllowed: true,
      requestModified: false,
      responseAllowed: true,
      responseModified: false,
    };

    // Parse headers
    const reqHeaders: Record<string, string> = data.requestHeaders
      ? JSON.parse(data.requestHeaders)
      : {};
    const respHeaders: Record<string, string> = data.responseHeaders
      ? JSON.parse(data.responseHeaders)
      : {};
    const statusCode = data.statusCode ? parseInt(data.statusCode) : 0;

    // Create validation context
    const valCtx: ValidationContext = {
      ip: data.ip,
      endpoint: data.path,
      method: data.method,
      requestHeaders: reqHeaders,
      responseHeaders: respHeaders,
      statusCode,
      requestPayload: data.requestPayload,
      responsePayload: data.responsePayload,
      rateLimitPolicy: rateLimitPolicy,
      executionCtx: config.executionCtx,
    };

    // Validate request if present
    if (data.requestPayload) {
      try {
        const processResult = await processor.processRequest(
          data.requestPayload,
          valCtx,
          policies,
          auditPolicies,
          hasAuditRules
        );

        result.requestAllowed = !processResult.isBlocked;
        result.requestModified = !!processResult.modifiedPayload;
        result.requestModifiedPayload = processResult.modifiedPayload;
      } catch (error) {
        console.error("[ValidationHandler] Request validation error:", error);
        result.requestError = String(error);
      }
    }

    // Validate response if present
    if (data.responsePayload) {
      try {
        const processResult = await processor.processResponse(
          data.responsePayload,
          valCtx,
          policies
        );

        result.responseAllowed = !processResult.isBlocked;
        result.responseModified = !!processResult.modifiedPayload;
        result.responseModifiedPayload = processResult.modifiedPayload;
      } catch (error) {
        console.error("[ValidationHandler] Response validation error:", error);
        result.responseError = String(error);
      }
    }

    results.push(result);
  }

  return results;
}

/**
 * Handle single request validation
 */
export async function handleRequestValidation(
  payload: string,
  valCtx: ValidationContext,
  policies: Policy[],
  auditPolicies: Record<string, AuditPolicy>,
  hasAuditRules: boolean,
  modelExecutorBinding: Fetcher,
  tbsHost: string,
  tbsToken: string,
  executionCtx?: ExecutionContext,
  databaseAbstractorUrl?: string,
  aktoApiToken?: string,
  rateLimitKV?: KVNamespace
): Promise<{ allowed: boolean; modified: boolean; modifiedPayload?: string; reason?: string; shouldBlock?: boolean; action?: "ALLOW" | "BLOCK"; metadata?: Record<string, any> }> {
  const processor = new MCPProcessor(
    modelExecutorBinding,
    tbsHost,
    tbsToken,
    false,
    executionCtx,
    databaseAbstractorUrl,
    aktoApiToken,
    rateLimitKV
  );

  const processResult = await processor.processRequest(
    payload,
    valCtx,
    policies,
    auditPolicies,
    hasAuditRules
  );

  return {
    allowed: !processResult.isBlocked,
    modified: !!processResult.modifiedPayload,
    modifiedPayload: processResult.modifiedPayload,
    reason: processResult.blockedResponse
      ? JSON.stringify(processResult.blockedResponse)
      : undefined,
    shouldBlock: processResult.isBlocked,
    action: processResult.isBlocked ? "BLOCK" : "ALLOW",
  };
}

/**
 * Handle single response validation
 */
export async function handleResponseValidation(
  payload: string,
  valCtx: ValidationContext,
  policies: Policy[],
  modelExecutorBinding: Fetcher,
  tbsHost: string,
  tbsToken: string,
  executionCtx?: ExecutionContext,
  databaseAbstractorUrl?: string,
  aktoApiToken?: string,
  rateLimitKV?: KVNamespace
): Promise<{ allowed: boolean; modified: boolean; modifiedPayload?: string; reason?: string; shouldBlock?: boolean; action?: "ALLOW" | "BLOCK"; metadata?: Record<string, any> }> {
  const processor = new MCPProcessor(
    modelExecutorBinding,
    tbsHost,
    tbsToken,
    false,
    executionCtx,
    databaseAbstractorUrl,
    aktoApiToken,
    rateLimitKV
  );

  const processResult = await processor.processResponse(payload, valCtx, policies);

  return {
    allowed: !processResult.isBlocked,
    modified: !!processResult.modifiedPayload,
    modifiedPayload: processResult.modifiedPayload,
    reason: processResult.blockedResponse
      ? JSON.stringify(processResult.blockedResponse)
      : undefined,
    shouldBlock: processResult.isBlocked,
    action: processResult.isBlocked ? "BLOCK" : "ALLOW",
  };
}
