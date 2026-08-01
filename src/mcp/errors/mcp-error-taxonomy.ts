/*─────────────────────────────────────────────────────────────────────
  MCP Error Taxonomy — authoritative mapping per roadmap §6.
  Every internal failure signal maps to exactly one JSON‑RPC error code.
  No known signal falls through to -32603.
─────────────────────────────────────────────────────────────────────*/

// ── Standard JSON-RPC 2.0 codes ────────────────────────────────────
export const STANDARD_ERRORS = {
  PARSE_ERROR:            -32700,
  INVALID_REQUEST:        -32600,
  METHOD_NOT_FOUND:       -32601,
  INVALID_PARAMS:         -32602,
  INTERNAL_ERROR:         -32603,
} as const;

// ── AgentGate domain codes (-32000 … -32099) ───────────────────────
export const GATEWAY_ERRORS = {
  PERMISSION_DENIED:            -32000,
  RATE_LIMITED:                 -32001,
  SERVICE_DEGRADED:             -32002,
  TOOL_NOT_FOUND:               -32003,
  TOOL_EXECUTION_ERROR:         -32004,
  TOOL_EXECUTION_TIMEOUT:       -32005,
  PAYLOAD_TOO_LARGE:            -32006,
  UNSUPPORTED_MEDIA_TYPE:       -32007,
  SSRF_BLOCKED:                 -32008,
  IDENTITY_INVALID:             -32009,
  MESSAGE_RATE_LIMITED:         -32010,
  UNSUPPORTED_PROTOCOL_VERSION: -32011,
  ORIGIN_NOT_ALLOWED: -32012,
} as const;

export type McpErrorCode =
  | (typeof STANDARD_ERRORS)[keyof typeof STANDARD_ERRORS]
  | (typeof GATEWAY_ERRORS)[keyof typeof GATEWAY_ERRORS];

// ── Internal signal names (keys for the mapping function) ─────────
export const ErrorSignal = {
  ...STANDARD_ERRORS,
  ...GATEWAY_ERRORS,
} as const;
export type ErrorSignalName = keyof typeof ErrorSignal;  // renamed for clarity

// ── Default human‑readable messages ────────────────────────────────
const SIGNAL_MESSAGES: Record<ErrorSignalName, string> = {
  PARSE_ERROR:                   "Failed to parse request body as JSON.",
  INVALID_REQUEST:               "Invalid JSON-RPC envelope.",
  METHOD_NOT_FOUND:              "Unknown JSON-RPC method.",
  INVALID_PARAMS:                "Invalid method parameters (schema validation failed).",
  INTERNAL_ERROR:                "An unexpected internal error occurred.",
  PERMISSION_DENIED:             "Agent does not have permission to invoke this tool.",
  RATE_LIMITED:                  "Agent rate limit exceeded.",
  SERVICE_DEGRADED:              "Service temporarily degraded; retry later.",
  TOOL_NOT_FOUND:                "Tool not found for this tenant.",
  TOOL_EXECUTION_ERROR:          "Tool execution failed.",
  TOOL_EXECUTION_TIMEOUT:        "Tool execution timed out.",
  PAYLOAD_TOO_LARGE:             "Tool response payload too large.",
  UNSUPPORTED_MEDIA_TYPE:        "Unsupported media type in tool response.",
  SSRF_BLOCKED:                  "Target blocked by SSRF protection.",
  IDENTITY_INVALID:              "Invalid or inactive agent / suspended tenant.",
  MESSAGE_RATE_LIMITED:          "Coarse message rate limit exceeded.",
  UNSUPPORTED_PROTOCOL_VERSION:  "Protocol version not supported.",
  ORIGIN_NOT_ALLOWED: "Request Origin is not in the allowed list.",
};

/**
 * Single source of truth: maps every known signal → { code, message }.
 * Day 2‑4 modules import this; they never hardcode error numbers.
 */
export function signalToError(signal: ErrorSignalName): {
  code: McpErrorCode;
  message: string;
} {
  const code = ErrorSignal[signal];
  return { code, message: SIGNAL_MESSAGES[signal] };
}

// ── Convenience error class ────────────────────────────────────────
export class McpGatewayError extends Error {
  public readonly code: McpErrorCode;
  public readonly data?: unknown;

  constructor(code: McpErrorCode, message?: string, data?: unknown) {
    super(message ?? "MCP Gateway error");
    this.name = "McpGatewayError";
    this.code = code;
    this.data = data;
  }

  /** Factory from a well‑known signal. */
  static fromSignal(signal: ErrorSignalName, data?: unknown): McpGatewayError {
    const { code, message } = signalToError(signal);
    return new McpGatewayError(code, message, data);
  }
}

// ── JSON-RPC error response formatter ─────────────────────────────
export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export function formatMcpErrorResponse(
  error: unknown,
  requestId: string | number | null = null
): JsonRpcErrorResponse {
  if (error instanceof McpGatewayError) {
    return {
      jsonrpc: "2.0",
      id: requestId,
      error: {
        code: error.code,
        message: error.message,
        ...(error.data !== undefined && { data: error.data }),
      },
    };
  }

  // True unexpected error → generic -32603, using the mapping to avoid duplication.
  const fallback = signalToError("INTERNAL_ERROR");
  return {
    jsonrpc: "2.0",
    id: requestId,
    error: { code: fallback.code, message: fallback.message },
  };
}

/*
 * ⚠️ RULE (addressed to Day 2‑4):
 * McpGatewayError.data may be exposed to the client. It MUST NOT contain
 * raw internal error objects, secrets, or stack traces. Redact before
 * passing as data — consistent with the `redactSecrets()` discipline
 * already established in M4/M5.
 */