import type { HandlerStatus, ToolExecutionErrorCode } from "../handlers/types.js";

export interface AuditEventPayload {
  tenantId: string;
  agentId: string;
  toolId: string;
  eventType: "TOOL_INVOCATION";
  status: HandlerStatus;
  durationMs: number;
  errorCode?: ToolExecutionErrorCode | undefined;
  errorMessage?: string; // already redacted by the time this is populated
  timestamp: Date;
}

/**
 * Fire-and-forget: never awaited by the caller, never throws. Week 5
 * swaps this body for a real BullMQ `audit` queue enqueue without
 * changing this function's signature, AuditEventPayload's shape, or
 * executeTool() — the only caller — at all.
 */
export function enqueueAuditEvent(event: AuditEventPayload): void {
  try {
    console.log("[AUDIT STUB]", JSON.stringify(event));
  } catch {
    // An audit failure must never surface to the caller — the same
    // hard safety contract Week 5's real enqueueAuditEvent() has to
    // honor (roadmap.md Week 5 JIT notes).
  }
}