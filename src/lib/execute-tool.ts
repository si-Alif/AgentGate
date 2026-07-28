import { toolRepository } from "../repositories/tool.repository.js";
import { decryptConfig } from "./encryption.js";
import { handlerConfigSchema } from "./handler-config.schema.js";
import type { HandlerConfig } from "./handler-config.schema.js";
import { withTimeout } from "./timeout.js";
import { enqueueAuditEvent } from "./audit-stub.js";
import type { AuditEventPayload } from "./audit-stub.js";
import { redactSecrets } from "./error-redaction.js";
import { executeHttpHandler } from "../handlers/http-handler.js";
import { executePostgresHandler } from "../handlers/postgres-handler.js";
import { executeWebFetchHandler } from "../handlers/webfetch-handler.js";
import type { HandlerResult, ExecutionResult, ToolExecutionErrorCode } from "../handlers/types.js";
import { DEFAULT_TIMEOUT_MS, TimeoutError } from "../handlers/types.js";

/**
 * The M4 dispatcher (HLD §4.1). Deliberately NO resolver/dispatcher/
 * validate override parameters — see Decision 5.1. Production
 * (Week 6) never needs them; Day 5's own tests mock the handler
 * MODULE boundary instead (§6 below), which proves this function's
 * own logic without needing network-level plumbing threaded through
 * a public dispatcher contract.
 *
 * Deliberately does NOT validate inputParams against the tool's
 * input_schema — that's Week 6's job, on the gateway hot path,
 * before this function is ever called. See §3.1.
 */
export async function executeTool(
  toolId: string,
  tenantId: string,
  agentId: string,
  inputParams: Record<string, unknown>,
  externalSignal?: AbortSignal,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<ExecutionResult> {
  const startedAt = performance.now();

  const audit = (result: ExecutionResult): void => {
    const payload: AuditEventPayload = {
      tenantId,
      agentId,
      toolId,
      eventType: "TOOL_INVOCATION",
      status: result.status,
      durationMs: result.durationMs,
      timestamp: new Date(),
    };
    if (result.error !== undefined) payload.errorMessage = result.error;
    enqueueAuditEvent(payload);
  };

  // Builds the final, audited, redacted ExecutionResult from a raw
  // HandlerResult (or a dispatcher-level failure shaped the same
  // way). This is the ONE place `.error` gets redacted and `.errorCode`
  // gets assigned — every return path in this function goes through
  // it, so there is no path that skips redaction or leaves the audit
  // log unwritten.
  const finish = (partial: HandlerResult, errorCode?: ToolExecutionErrorCode): ExecutionResult => {
    const durationMs = Math.round(performance.now() - startedAt);

    const result: ExecutionResult = { status: partial.status, durationMs };
    if (partial.result !== undefined) result.result = partial.result;
    if (partial.error !== undefined) result.error = redactSecrets(partial.error);

    audit(result);
    return result;
  };

  try {
    const tool = await toolRepository.findById(toolId, tenantId);
    if (!tool) {
      // Scoped lookup returning null covers BOTH "doesn't exist" and
      // "belongs to a different tenant" — same convention Week 2's
      // agent/tool repositories already established. Existence must
      // not leak across tenants, so both cases produce this same
      // response, not two distinguishable ones.
      return finish({ status: "error", error: "Tool not found" }, "TOOL_NOT_FOUND");
    }

    if (!tool.isActive) {
      // Defense-in-depth against the TOCTOU gap between Week 6's
      // checkPermission() call and this call — a tool deactivated in
      // that window must not still execute. Mirrors the same
      // reasoning Week 3 already applied to checkPermission's own
      // freshness checks.
      return finish({ status: "error", error: "Tool is not active" }, "TOOL_INACTIVE");
    }

    let plaintext: string;
    try {
      plaintext = decryptConfig(tool.handlerConfig, tenantId);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return finish({ status: "error", error: `Failed to decrypt handler config: ${message}` }, "DECRYPTION_FAILED");
    }

    let config: HandlerConfig;
    try {
      config = handlerConfigSchema.parse(JSON.parse(plaintext));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return finish({ status: "error", error: `Invalid handler config: ${message}` }, "INVALID_HANDLER_CONFIG");
    }

    const handlerResult = await withTimeout(
      (signal) => dispatchToHandler(config, inputParams, signal),
      timeoutMs,
      externalSignal
    );

    return finish(handlerResult, classifyHandlerError(handlerResult));
  } catch (err: unknown) {
    if (err instanceof TimeoutError) {
      // withTimeout's own backstop — either a genuine timeout/external
      // abort, or (rarer) a handler that hung past its budget despite
      // its own documented contract. Either way, "timeout" is the
      // correct classification: the caller's budget was exceeded.
      return finish({ status: "timeout", error: err.message }, "TIMEOUT");
    }
    // A handler contract violation: every handler in this codebase is
    // documented to catch its own errors and return a structured
    // HandlerResult, never throw. Reaching here means that contract
    // was broken somewhere upstream of withTimeout's own backstop —
    // treat it as a generic handler error rather than mislabeling it
    // a timeout it may have nothing to do with.
    const message = err instanceof Error ? err.message : "Unexpected tool execution error";
    return finish({ status: "error", error: message }, "HANDLER_ERROR");
  }
}

async function dispatchToHandler(
  config: HandlerConfig,
  inputParams: Record<string, unknown>,
  signal: AbortSignal
): Promise<HandlerResult> {
  switch (config.handlerType) {
    case "http":
      return executeHttpHandler(config, inputParams, signal);
    case "postgres":
      return executePostgresHandler(config, inputParams, signal);
    case "web_fetch":
      return executeWebFetchHandler(config, inputParams, signal);
    default: {
      const exhaustive: never = config;
      return { status: "error", error: `Unknown handler type: ${JSON.stringify(exhaustive)}` };
    }
  }
}

/**
 * Recovers a stable ToolExecutionErrorCode from a HandlerResult that
 * only carries {status, error?: string}. The SSRF branch is a
 * message-prefix check, not a structural signal — see Decision 5.5
 * for exactly why that trade-off was chosen over touching three
 * already-shipped handler files, and what a cleaner future version
 * would look like.
 */
function classifyHandlerError(result: HandlerResult): ToolExecutionErrorCode | undefined {
  switch (result.status) {
    case "success":
      return undefined;
    case "timeout":
      return "TIMEOUT";
    case "payload_too_large":
      return "PAYLOAD_TOO_LARGE";
    case "unsupported_media_type":
      return "UNSUPPORTED_MEDIA_TYPE";
    case "error":
      return result.error?.startsWith("SSRF blocked") ? "SSRF_BLOCKED" : "HANDLER_ERROR";
  }
}