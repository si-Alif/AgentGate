import { McpGatewayError } from "../errors/mcp-error-taxonomy.js";
import type { PermissionCheckResult } from "../../lib/permission-engine.js";
import type { ToolExecutionErrorCode } from "../../handlers/types.js";

type PermissionDenial = Extract<PermissionCheckResult, { granted: false }>;


export function mapPermissionDenialToError(result: PermissionDenial): McpGatewayError {
  switch (result.reason) {
    case "not_found":
    case "permission_inactive":
      return McpGatewayError.fromSignal("PERMISSION_DENIED", { reason: result.reason });

    case "tool_inactive":
      return McpGatewayError.fromSignal("TOOL_NOT_FOUND", { reason: result.reason });

    // if the agent is inactive or the tenant is suspended, it's an identity crisis
    case "agent_inactive":
    case "tenant_suspended":
      return McpGatewayError.fromSignal("IDENTITY_INVALID", { reason: result.reason });

    case "error":
      // CRITICAL: result.error (the raw exception from
      // permissionRepository.findGrantWithContext's own catch block,
      // is NEVER forwarded here. It was never designed to be client-facing
      return McpGatewayError.fromSignal("SERVICE_DEGRADED", { reason: "permission_check_failed" });

    default: {
      const exhaustive: never = result.reason;
      return McpGatewayError.fromSignal("INTERNAL_ERROR", { unmappedReason: exhaustive });
    }
  }
}


export function mapToolExecutionErrorToError(
  errorCode: ToolExecutionErrorCode,
  detail?: string
): McpGatewayError {
  const data = detail !== undefined ? { detail } : undefined;

  switch (errorCode) {
    case "TOOL_NOT_FOUND":
    case "TOOL_INACTIVE":
      // Mirrors tools/list's own behavior (an inactive tool is
      // silently OMITTED from discovery, never flagged as "exists but
      // deactivated") and mapPermissionDenialToError's "tool_inactive"
      // case above — consistent across both mapping tables.
      return McpGatewayError.fromSignal("TOOL_NOT_FOUND", data);
    case "INFRA_UNAVAILABLE":
      return McpGatewayError.fromSignal("SERVICE_DEGRADED", data);
    case "SSRF_BLOCKED":
    return McpGatewayError.fromSignal("SSRF_BLOCKED", data);
    case "DECRYPTION_FAILED":
    case "INVALID_HANDLER_CONFIG":
    case "HANDLER_ERROR":
      // NOT SERVICE_DEGRADED: per-tool, persistent, tenant-admin-
      // actionable config faults, not a transient gateway-wide
      // problem. SERVICE_DEGRADED's documented meaning ("retry
      // later") would be actively misleading — retrying changes
      // nothing until the tool's stored config is fixed.
      return McpGatewayError.fromSignal("TOOL_EXECUTION_ERROR", data);

    case "TIMEOUT":
      return McpGatewayError.fromSignal("TOOL_EXECUTION_TIMEOUT", data);
    case "PAYLOAD_TOO_LARGE":
      return McpGatewayError.fromSignal("PAYLOAD_TOO_LARGE", data);
    case "UNSUPPORTED_MEDIA_TYPE":
      return McpGatewayError.fromSignal("UNSUPPORTED_MEDIA_TYPE", data);

    default: {
      const exhaustive: never = errorCode;
      return McpGatewayError.fromSignal("INTERNAL_ERROR", { unmappedCode: exhaustive });
    }
  }
}