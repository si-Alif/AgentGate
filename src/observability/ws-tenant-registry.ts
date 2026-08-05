import { WebSocket } from "ws";
import { redis } from "../lib/redis.js";
import { tenantEventChannelName } from "../lib/audit-publish.js";
import type { LiveExecutionEvent } from "../lib/audit-publish.js";
import { sendEventFrame, rejectConnection, WS_CLOSE_CODE, closeConnectionForShutdown } from "./ws-protocol.js";
import { env } from "../config/env.js";
import { withTimeout } from "../lib/timeout.js";
import { TimeoutError } from "../handlers/types.js";


export const tenantEventSubscriber = redis.duplicate({
  connectionName: "agentgate:tenant-event-subscriber",
});

tenantEventSubscriber.on("error", (err: Error) => {
  console.error("[ws-tenant-registry] subscriber connection error:", err.message);
});

tenantEventSubscriber.on("message", dispatchTenantMessage);

const viewersByTenant = new Map<string, Set<WebSocket>>();
export type ObservabilityStreamHealthReason =
  | "HEALTHY"
  | "SUBSCRIBER_NOT_READY"
  | "PING_TIMEOUT"
  | "PING_ERROR";

export interface ObservabilityStreamHealth {
  healthy: boolean;
  reason: ObservabilityStreamHealthReason;
  subscribedTenantCount: number;
  totalViewerCount: number;
}

const OBSERVABILITY_HEALTH_PING_TIMEOUT_MS = 2_000; // matches getAuditHealth()'s own METRICS_TIMEOUT_MS precedent


export function registerTenantViewer(tenantId: string, socket: WebSocket): void {
  const existing = viewersByTenant.get(tenantId);
  const wasEmpty = !existing || existing.size === 0;

  if (existing) {
    existing.add(socket);
  } else {
    viewersByTenant.set(tenantId, new Set([socket]));
  }

  if (wasEmpty) {
    tenantEventSubscriber.subscribe(tenantEventChannelName(tenantId)).catch((err: unknown) => {
      console.error(
        `[ws-tenant-registry] SUBSCRIBE failed for tenant ${tenantId} — live events for this ` +
        `tenant may be delayed until a subsequent successful subscribe (redis.ts's own ` +
        `maxRetriesPerRequest: null on this connection means the command keeps retrying, ` +
        `it does not permanently fail):`,
        err
      );
    });
  }
}


export function deregisterTenantViewer(tenantId: string, socket: WebSocket): void {
  const existing = viewersByTenant.get(tenantId);
  if (!existing) return;

  existing.delete(socket);

  if (existing.size === 0) {
    viewersByTenant.delete(tenantId);
    tenantEventSubscriber.unsubscribe(tenantEventChannelName(tenantId)).catch((err: unknown) => {
      console.warn(
        `[ws-tenant-registry] UNSUBSCRIBE failed for tenant ${tenantId} — a harmless orphaned ` +
        `Redis-side subscription may persist. This is NOT a delivery-correctness concern ` +
        `(Decision 7.49): the local registry, now empty, remains the sole authoritative gate ` +
        `on fan-out — an orphaned subscription can waste bandwidth but can never deliver an ` +
        `event to a socket that isn't locally registered.`,
        err
      );
    });
  }
}

/**
 * Wired as tenantEventSubscriber's connection-level 'message' handler
 * at module load — ALL channels this connection is subscribed to
 * funnel through this ONE handler; dispatch by `channel` is this
 * function's entire job.
 */
export function dispatchTenantMessage(channel: string, message: string): void {
  const tenantId = parseTenantIdFromChannel(channel);
  if (!tenantId) {
    console.warn(`[ws-tenant-registry] message received on an unrecognized channel shape: ${channel}`);
    return;
  }

  const viewers = viewersByTenant.get(tenantId);
  if (!viewers || viewers.size === 0) {
    return;
  }

  let event: LiveExecutionEvent;
  try {
    event = JSON.parse(message) as LiveExecutionEvent;
  } catch (err) {
    console.error(`[ws-tenant-registry] failed to parse pub/sub payload for tenant ${tenantId}:`, err);
    return;
  }

  for (const socket of Array.from(viewers)) {
    try {
      if (socket.readyState !== WebSocket.OPEN) {
        continue; // mirrors ws-connection-tracker.ts's own cleanup discipline
      }

      if(socket.bufferedAmount > env.AGENTGATE_WS_BACKPRESSURE_THRESHOLD_BYTES) {
        rejectConnection(socket, WS_CLOSE_CODE.POLICY_VIOLATION);
        continue;
      }

      sendEventFrame(socket, event);
    } catch (err) {
      console.warn(
        `[ws-tenant-registry] failed to deliver a live event to one viewer of tenant ${tenantId} ` +
        `— continuing delivery to the rest of this tenant's viewers:`,
        err
      );
    }
  }
}

function parseTenantIdFromChannel(channel: string): string | null {
  const prefix = tenantEventChannelName("");
  if (!channel.startsWith(prefix)) return null;
  const tenantId = channel.slice(prefix.length);
  return tenantId.length > 0 ? tenantId : null;
}

/**
 * Diagnostic-only accessors (Decision 7.48) — never consulted on a
 * request-handling path. Ready for Day 5's /health tie-in without
 * requiring Day 5 to touch this module's internals.
 */
export function getViewerCountForTenant(tenantId: string): number {
  return viewersByTenant.get(tenantId)?.size ?? 0;
}

export function getSubscribedTenantCount(): number {
  return viewersByTenant.size;
}

/**
 * Graceful-shutdown helper (Decision 7.48) — Day 5 wires this into
 * server.ts's shutdown sequence, after closing every locally-held WS.
 */
export async function closeTenantEventSubscriber(): Promise<void> {
  await tenantEventSubscriber.quit();
}

export function getAllRegisteredSockets(): WebSocket[] {
  const all = new Set<WebSocket>();
    for (const set of viewersByTenant.values()) {
      for (const socket of set) all.add(socket);
    }
  return Array.from(all);
}

// Diagnostic-only — aggregate viewer count across every tenant on this replica.
export function getTotalViewerCount(): number {
  let total = 0;

  for (const set of viewersByTenant.values()) total += set.size;

  return total;
}


export async function closeAllObservabilityConnections(graceMs?: number): Promise<void> {
  const sockets = getAllRegisteredSockets();
  await Promise.all(sockets.map((socket) => closeConnectionForShutdown(socket, graceMs)));
}

export async function getObservabilityStreamHealth(): Promise<ObservabilityStreamHealth> {
  try {
    if (tenantEventSubscriber.status !== "ready") {
      return {
        healthy: false,
        reason: "SUBSCRIBER_NOT_READY",
        subscribedTenantCount: getSubscribedTenantCount(),
        totalViewerCount: getTotalViewerCount(),
      };
    }
    try {
      await withTimeout(() => tenantEventSubscriber.ping(), OBSERVABILITY_HEALTH_PING_TIMEOUT_MS);
    } catch (err: unknown) {
      const reason: ObservabilityStreamHealthReason = err instanceof TimeoutError ? "PING_TIMEOUT" : "PING_ERROR";
      return {
        healthy: false,
        reason,
        subscribedTenantCount: getSubscribedTenantCount(),
        totalViewerCount: getTotalViewerCount(),
      };
    }
    return {
      healthy: true,
      reason: "HEALTHY",
      subscribedTenantCount: getSubscribedTenantCount(),
      totalViewerCount: getTotalViewerCount(),
    };
  }catch (_unexpected) {
    return { healthy: false, reason: "PING_ERROR", subscribedTenantCount: 0, totalViewerCount: 0 };
  }
}


/** Test-only: full reset between test cases. Never called in production. */
export async function resetTenantRegistryForTest(): Promise<void> {
  const tenantIds = [...viewersByTenant.keys()];
  viewersByTenant.clear();
  await Promise.all(
    tenantIds.map((tenantId) =>
      tenantEventSubscriber.unsubscribe(tenantEventChannelName(tenantId)).catch(() => {
        // best-effort cleanup between test cases only
      })
    )
  );
}