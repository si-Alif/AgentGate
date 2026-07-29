import type{ToolInvocationJobPayload} from "./audit-schema.js"
import { auditQueue } from "../queue/audit.queue.js";
import { auditJobPayloadSchema } from "./audit-schema.js";
import type { AuditJobPayload } from "./audit-schema.js";

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


export function enqueueAuditEvent(event: AuditJobPayload): void {
  const parsed = auditJobPayloadSchema.safeParse(event);

  if (!parsed.success) {
    const idHint = typeof (event as { id?: unknown })?.id === "string" ? (event as { id: string }).id : "unknown";
    console.warn(
      `[audit] refused to enqueue a malformed payload (id=${idHint}) — this invocation will have NO audit trail:`,
      parsed.error.flatten()
    );
    return;
  }

  const payload = parsed.data;

  auditQueue
    .add(payload.eventType, payload, {
      // A cheap, non-load-bearing second layer over the DB-level
      // idempotency guarantee (Day 3's shared-PK + P2002-as-success
      // handling)
      jobId: payload.id,
    })
    .catch((err: unknown) => {
      console.warn(
        `[audit] failed to enqueue audit event ${payload.id} — this invocation will have NO audit trail:`,
        err
      );
    });
}