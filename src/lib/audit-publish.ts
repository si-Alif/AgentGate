import { redis } from "./redis.js";
import type { AuditJobPayload } from "./audit-schema.js";
import { isInvocationShapedEvent } from "./audit-schema.js";


export interface LiveExecutionEvent {
  id: string;
  tenantId: string;
  eventType: AuditJobPayload["eventType"];
  agentId?: string;
  toolId?: string;
  status?: string;
  durationMs?: number;
  errorCode?: string;
  timestamp: string; // ISO — pub/sub payloads are always plain JSON strings
}

export function tenantEventChannelName(tenantId: string): string {
  return `events:tenant:${tenantId}`;
}

function buildLiveEvent(payload: AuditJobPayload): LiveExecutionEvent {
  const event: LiveExecutionEvent = {
    id: payload.id,
    tenantId: payload.tenantId,
    eventType: payload.eventType,
    timestamp: payload.timestamp.toISOString(),
  };

  if ("agentId" in payload) event.agentId = payload.agentId;
  if (isInvocationShapedEvent(payload)) {
    event.toolId = payload.toolId;
    event.status = payload.status;
    event.durationMs = payload.durationMs;
    if (payload.errorCode !== undefined) event.errorCode = payload.errorCode;
  }

  return event;
}


export async function publishLiveEvent(payload: AuditJobPayload): Promise<void> {
  const event = buildLiveEvent(payload);
  try {
    await redis.publish(tenantEventChannelName(payload.tenantId), JSON.stringify(event));
  } catch (err) {
    console.error(`[audit-publish] failed to publish live event ${payload.id}:`, err);
  }
}