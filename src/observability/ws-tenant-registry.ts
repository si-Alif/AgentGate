import { WebSocket } from "ws";
import { redis } from "../lib/redis.js";
import { tenantEventChannelName } from "../lib/audit-publish.js";
import type { LiveExecutionEvent } from "../lib/audit-publish.js";
import { sendEventFrame } from "./ws-protocol.js";

/**
 * The reference-counted bridge between Redis pub/sub and this
 * replica's locally-held dashboard WebSocket connections.
 *
 * ONE dedicated subscriber-mode connection per replica, built via
 * redis.duplicate() off the SHARED lib/redis.ts client — deliberately
 * NOT rateLimiterRedis.duplicate() (Day 3 Finding F1 / Decision 7.41).
 * rateLimiterRedis is tuned fail-fast (maxRetriesPerRequest: 1,
 * commandTimeout: 1000ms) for point-in-time rate-limit checks; a
 * long-lived subscriber has no "check" to fail fast on — it should
 * retry indefinitely, exactly what redis.ts's maxRetriesPerRequest:
 * null already gives it, and exactly what BullMQ already depends on
 * that same setting for. Duplicating from redis.ts also means this
 * connects to the identical Redis target/auth/TLS configuration as
 * the PUBLISH side (audit-publish.ts), with zero extra config to keep
 * in sync.
 *
 * Once a connection issues SUBSCRIBE it can no longer issue ordinary
 * commands — this is why a genuinely separate connection instance is
 * structurally required, not merely preferred (the same reason the
 * rate limiter needed its own client, Week 3 — a different underlying
 * cause there: conflicting reliability settings; here: Redis's own
 * subscriber-mode command restriction).
 */
export const tenantEventSubscriber = redis.duplicate();

tenantEventSubscriber.on("error", (err: Error) => {
  console.error("[ws-tenant-registry] subscriber connection error:", err.message);
});

tenantEventSubscriber.on("message", dispatchTenantMessage);

const viewersByTenant = new Map<string, Set<WebSocket>>();

/**
 * Synchronous check-then-mutate, mirroring ws-connection-tracker.ts's
 * own registerConnection() reasoning (Week 7 Day 2): Node's single-
 * threaded event loop means there is no `await` between reading
 * `wasEmpty` and mutating the Set, so two "simultaneous" registrations
 * for the same tenant are still processed one full synchronous turn
 * at a time — SUBSCRIBE fires on the empty -> nonempty transition
 * ONLY, never twice for concurrent joiners.
 *
 * The actual SUBSCRIBE call is fire-and-forget (Decision 7.46) —
 * mirrors enqueueAuditEvent()'s established "never await" contract
 * (Week 4/5). Registration must never block the connection handshake
 * waiting on a Redis round trip; delivery is already a best-effort
 * contract (Week 5's own accepted posture), so a brief window where
 * the local bookkeeping exists slightly ahead of the actual Redis
 * subscription is an acceptable, bounded imprecision, not a
 * correctness bug.
 */
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

/**
 * The single cleanup authority for THIS module's state — a sibling to,
 * never merged with, ws-connection-tracker.ts's own
 * deregisterConnection() (Decision 7.45, resolving Day 2's own
 * forward note). The two modules own fully disjoint state with no
 * ordering dependency between them, so a socket's 'close' event
 * triggers BOTH cleanup functions via two independent .once()
 * listeners registered at the route-handler level
 * (routes/observability.ts), rather than funneling through one shared
 * coordinator neither module needs.
 *
 * Idempotent: deregistering a socket never registered under this
 * tenantId, or already removed, is a safe no-op.
 */
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
 *
 * Checks the local registry BEFORE parsing the payload — Day 3's own
 * proof checkpoint ("a tenant with zero current viewers never has its
 * events... even parsed locally") is enforced structurally here, not
 * merely observed as a side effect.
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

  for (const socket of viewers) {
    try {
      if (socket.readyState === WebSocket.OPEN) {
        sendEventFrame(socket, event);
      }
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