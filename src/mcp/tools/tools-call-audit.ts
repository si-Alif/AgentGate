import crypto from "node:crypto";
import { capturePreview } from "../../lib/audit-preview.js";
import { enqueueAuditEvent } from "../../lib/audit-stub.js";
import type { PermissionCheckResult } from "../../lib/permission-engine.js";
import type { RateLimitResult } from "../../lib/rate-limiter.js";
import type {
  PermissionDeniedJobPayload,
  RateLimitedJobPayload,
} from "../../lib/audit-schema.js";

type PermissionDenial = Extract<PermissionCheckResult, { granted: false }>;


type AuditablePermissionDenialReason = Exclude<PermissionDenial["reason"], "error">;

function isAuditableDenial(
  result: PermissionDenial
): result is PermissionDenial & { reason: AuditablePermissionDenialReason } {
  return result.reason !== "error";
}

export interface ToolCallAuditContext {
  tenantId: string;
  agentId: string;
  toolId: string;
  toolArguments: Record<string, unknown>;
  //Wall-clock —Captured once, at the very top of the POST handler.
  requestReceivedAt: Date;
  // performance.now() at the same moment — used only for durationMs math.
  requestStart: number;
}

/*
 * Fire-and-forget, exactly like enqueueAuditEvent() itself: the caller
 * never awaits this, and — per this function's own internal try/catch —
 * it never throws, mirroring execute-tool.ts's own audit() closure
 * discipline . A bug in preview capture or ID
 * generation must never fail a live tools/call request.
 */
export function auditPermissionDenied(ctx: ToolCallAuditContext, result: PermissionDenial): void {
  if (!isAuditableDenial(result)) return; // "error" is a non-auditable denial reason

  try {
    const completedAt = new Date();
    const inputCap = capturePreview(ctx.toolArguments);

    const payload: PermissionDeniedJobPayload = {
      id: crypto.randomUUID(),
      schemaVersion: 1,
      eventType: "PERMISSION_DENIED",
      tenantId: ctx.tenantId,
      agentId: ctx.agentId,
      toolId: ctx.toolId,
      status: "denied",
      denialReason: result.reason,
      // the FULL pipeline latency; there is no
      // execution phase to subtract, because none occurred.
      durationMs: Math.max(0, Math.round(performance.now() - ctx.requestStart)),
      startedAt: ctx.requestReceivedAt,
      completedAt,
      timestamp: completedAt,
      inputTruncated: inputCap.truncated,
      outputTruncated: false, // vacuously true — there is no output
    };
    if (inputCap.preview !== undefined) payload.inputPreview = inputCap.preview;

    enqueueAuditEvent(payload);
  } catch (err) {
    console.error("[tools-call-audit] failed to build/enqueue PERMISSION_DENIED audit event:", err);
  }
}

/**
 * Symmetric to auditPermissionDenied — Decision 5.4: a degraded
 * (circuit-breaker-open / infra-fault) rate-limit result is never
 * audited as a genuine RATE_LIMITED policy event.
 */
export function auditRateLimited(ctx: ToolCallAuditContext, result: RateLimitResult): void {
  if (result.degraded) return; // Decision 5.4

  try {
    const completedAt = new Date();
    // By this pipeline stage (checkRateLimit runs AFTER AJV validation,
    // per Day 4's Decision 4.5), toolArguments have already passed
    // schema validation — capturing them here is safe and meaningful.
    const inputCap = capturePreview(ctx.toolArguments);

    const payload: RateLimitedJobPayload = {
      id: crypto.randomUUID(),
      schemaVersion: 1,
      eventType: "RATE_LIMITED",
      tenantId: ctx.tenantId,
      agentId: ctx.agentId,
      toolId: ctx.toolId,
      status: "rate_limited",
      durationMs: Math.max(0, Math.round(performance.now() - ctx.requestStart)),
      startedAt: ctx.requestReceivedAt,
      completedAt,
      timestamp: completedAt,
      inputTruncated: inputCap.truncated,
      outputTruncated: false,
    };
    if (inputCap.preview !== undefined) payload.inputPreview = inputCap.preview;

    enqueueAuditEvent(payload);
  } catch (err) {
    console.error("[tools-call-audit] failed to build/enqueue RATE_LIMITED audit event:", err);
  }
}