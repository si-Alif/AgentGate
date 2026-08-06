import { env } from "../../config/env.js";
import { toolRepository } from "../../repositories/tool.repository.js";
import { checkPermission } from "../../lib/permission-engine.js";
import { checkRateLimit } from "../../lib/rate-limiter.js";
import { executeTool } from "../../lib/execute-tool.js";
import { globalValidatorCache } from "../cache/ajv-validator-cache.js";
import { toolsCallParamsSchema } from "./tools-call-params.schema.js";
import { mapPermissionDenialToError, mapToolExecutionErrorToError } from "./tools-call-error-mapping.js";
import { McpGatewayError } from "../errors/mcp-error-taxonomy.js";
import {DEFAULT_TIMEOUT_MS} from "../../handlers/types.js";
import {auditPermissionDenied , auditRateLimited} from "./tools-call-audit.js";

import type {ToolCallAuditContext} from "./tools-call-audit.js";
import type { ResolvedIdentity } from "../auth/mcp-auth-resolver.js";

export interface ToolsCallResult {
  output: unknown;
  durationMs: number;
  _meta: { gatewayOverheadMs: number };
}

/**
 * The tools/call pipeline. Pipeline order :
 * resolve name (tenant-scoped) -> checkPermission -> AJV validate (cached) -> checkRateLimit -> executeTool -> return.
 *
 * Every non-success branch THROWS a McpGatewayError — never returns a
 * partial/ambiguous result. The /mcp scope's own setErrorHandler
 *  does all id-extraction and response formatting;
 * this function is Fastify-agnostic by design, matching
 * handleToolsList's own convention.
 */
export async function handleToolsCall(
  identity: ResolvedIdentity,
  rawParams: unknown,
  requestStart: number,
  abortSignal: AbortSignal,
  mcpNameHeader?: string,
  requestReceivedAt : Date = new Date()
): Promise<ToolsCallResult> {
  const parsedParams = toolsCallParamsSchema.safeParse(rawParams);
  if (!parsedParams.success) {
    throw McpGatewayError.fromSignal("INVALID_PARAMS", {
      reason: "malformed_tools_call_params",
      issues: parsedParams.error.flatten(),
    });
  }
  const { name, arguments: toolArguments } = parsedParams.data;


  if (mcpNameHeader !== undefined && mcpNameHeader !== name) {
    throw McpGatewayError.fromSignal("INVALID_REQUEST", { reason: "mcp_name_header_body_mismatch" });
  }

  let tool: Awaited<ReturnType<typeof toolRepository.findByName>>;
  try {
    tool = await toolRepository.findByName(name, identity.tenantId);
  }catch (err : unknown ){
    throw McpGatewayError.fromSignal("SERVICE_DEGRADED", { reason: "tool_name_resolution_failed" });
  }
  if (!tool) {
    throw McpGatewayError.fromSignal("TOOL_NOT_FOUND", { name });
  }

  const auditContext: ToolCallAuditContext = {
    tenantId: identity.tenantId,
    agentId: identity.agentId,
    toolId: tool.id,
    toolArguments,
    requestReceivedAt,
    requestStart
  };


  const permissionResult = await checkPermission(identity.agentId, tool.id, identity.tenantId);
  if (!permissionResult.granted) {
    auditPermissionDenied(auditContext, permissionResult);
    throw mapPermissionDenialToError(permissionResult);
  }

  // Decision 4.5 — AJV runs HERE, before checkRateLimit, amending
  // Decision 6.9's literal order. Permission is already confirmed
  // granted, so there is no information-disclosure risk in validating
  // shape now; AJV is in-memory/CPU-only and strictly cheaper than the
  // Redis round-trip checkRateLimit needs, so an already-authorized
  // agent's malformed-argument requests no longer burn its rate-limit
  // budget for a request that was always going to fail. Still bounded
  // by Day 2's coarse, pre-body-parse message-rate limit — see
  // roadmap_w6_d4.md §A.7 for why this reordering is safe.
  const validate = globalValidatorCache.getOrCompile(tool.id, tool.inputSchema as object);
  if (!validate(toolArguments)) {
    throw McpGatewayError.fromSignal("INVALID_PARAMS", {
      reason: "tool_arguments_schema_validation_failed",
      issues: validate.errors,
    });
  }

  const rateLimitResult = await checkRateLimit(identity.agentId, env.AGENTGATE_MCP_TOOL_CALL_RATE_LIMIT , identity.tenantId);
  if (!rateLimitResult.allowed) {
    auditRateLimited(auditContext, rateLimitResult);
    throw McpGatewayError.fromSignal(rateLimitResult.degraded ? "SERVICE_DEGRADED" : "RATE_LIMITED", {
      remaining: rateLimitResult.remaining,
    });
  }

  const gatewayOverheadMs = Math.max(0, Math.round(performance.now() - requestStart));

  const executionResult = await executeTool(
    tool.id,
    identity.tenantId,
    identity.agentId,
    toolArguments,
    abortSignal,
    DEFAULT_TIMEOUT_MS,
    gatewayOverheadMs
  );

  if (executionResult.status !== "success") {
    throw mapToolExecutionErrorToError(executionResult.errorCode ?? "HANDLER_ERROR", executionResult.error);
  }

  return {
    output: executionResult.result,
    durationMs: executionResult.durationMs,
    _meta: { gatewayOverheadMs },
  };
}