import type { HandlerStatus, ToolExecutionErrorCode } from "../handlers/types.js";
import type{ToolInvocationJobPayload} from "./audit-schema.js"

// export interface AuditEventPayload {
//   tenantId: string;
//   agentId: string;
//   toolId: string;
//   eventType: "TOOL_INVOCATION";
//   status: HandlerStatus;
//   durationMs: number;
//   errorCode?: ToolExecutionErrorCode | undefined;
//   errorMessage?: string; // already redacted by the time this is populated
//   timestamp: Date;
// }


export function enqueueAuditEvent(event: ToolInvocationJobPayload): void {
  try {
    console.log("[AUDIT STUB]", JSON.stringify(event));
  } catch {
    // An audit failure must never surface to the caller — the same
    // hard safety contract Week 5's real enqueueAuditEvent() has to
    // honor (roadmap.md Week 5 JIT notes).
  }
}