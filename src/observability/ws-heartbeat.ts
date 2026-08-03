import { WebSocket } from "ws";
import { env } from "../config/env.js";
import { terminateUnresponsiveConnection } from "./ws-protocol.js";
import { WS_CLOSE_CODE } from "./ws-protocol.js";

/**
 * Per-connection WebSocket liveness detection via native ping/pong
 * control frames (Decision 7.51/7.52, Day 4 Findings F2/F3).
 *
 * ONE independent setInterval PER CONNECTION, not a shared,
 * registry-driven sweep. Deliberately NOT built on top of Day 2's
 * ws-connection-tracker.ts or Day 3's ws-tenant-registry.ts —
 * heartbeat has no need to cross-reference userId or tenantId, and
 * folding a third concern into either existing registry would be
 * exactly the "one map, two questions" anti-pattern this project has
 * consistently avoided.
 *
 * A per-connection timer is the right tradeoff at THIS surface's
 * scale — dashboard viewers, bounded by
 * AGENTGATE_WS_MAX_CONNECTIONS_PER_USER (default 5) per user, not
 * agent-scale traffic. A single shared sweep over a global client Set
 * (the canonical `ws` idiom) would only pay for itself once connection
 * counts are large enough for per-timer overhead to matter — not this
 * surface's expected profile. Considered, not built; revisit only if
 * real usage ever proves otherwise.
 *
 * State is tracked via a WeakMap keyed by the socket instance, not by
 * mutating a property directly onto the imported `ws.WebSocket` type
 * (the canonical example does `ws.isAlive = true`) — this project's
 * strict TypeScript configuration makes monkey-patching a third-party
 * type a worse fit than an explicit, typed side-table. The WeakMap
 * also means the tracking ENTRY is automatically GC-eligible the
 * instant nothing else references the socket — only the timer (a
 * genuine live reference) needs explicit clearing via stopHeartbeat().
 */

interface HeartbeatState {
  isAlive: boolean;
  interval: NodeJS.Timeout;
}

const heartbeatState = new WeakMap<WebSocket, HeartbeatState>();

/**
 * Starts liveness tracking for a connection. Call exactly once, after
 * the connection has been fully registered (ceiling + tenant
 * registry) and the `connected` frame has been sent — mirrors the
 * ordering of every other per-connection setup step in
 * handleStreamUpgrade.
 *
 * `intervalMsOverride` is a pure testability seam (mirrors Week 5 Day
 * 6's `AuditWorkerOverrides` pattern) — defaults to the env-configured
 * production value; the real route call site never supplies it.
 */
export function startHeartbeat(socket: WebSocket, intervalMsOverride?: number): void {
  const intervalMs = intervalMsOverride ?? env.AGENTGATE_WS_HEARTBEAT_INTERVAL_MS;

  socket.on("pong", () => {
    const state = heartbeatState.get(socket);
    if (state) state.isAlive = true;
  });

  const interval = setInterval(() => {
    const state = heartbeatState.get(socket);
    if (!state) return; // stopHeartbeat already ran — nothing to do

    if (!state.isAlive) {
      // Decision 7.50/7.52 — a SINGLE missed pong triggers
      // termination, via terminate(), never a graceful close. By the
      // time this check fires, the peer already had one FULL
      // heartbeat interval, starting from the PREVIOUS ping, to
      // respond — already a generous grace window. Waiting for
      // additional consecutive misses only delays releasing a
      // genuinely dead connection's resources for no corresponding
      // benefit.
      terminateUnresponsiveConnection(socket, WS_CLOSE_CODE.HEARTBEAT_TIMEOUT);
      return;
    }

    state.isAlive = false;
    try {
      socket.ping();
    } catch (err) {
      console.warn("[ws-heartbeat] ping() failed — will retry next interval:", err);
    }
  }, intervalMs);

  heartbeatState.set(socket, { isAlive: true, interval });
}

/**
 * The single cleanup authority for THIS module's state — a sibling
 * to, never merged with, Day 2's ceiling-tracker or Day 3's
 * tenant-registry cleanup functions (Decision 7.56). Idempotent:
 * stopping a heartbeat that was never started, or already stopped, is
 * a safe no-op.
 */
export function stopHeartbeat(socket: WebSocket): void {
  const state = heartbeatState.get(socket);
  if (!state) return;
  clearInterval(state.interval);
  heartbeatState.delete(socket);
}

/** Diagnostic-only — never consulted on a request-handling path. */
export function isHeartbeatActive(socket: WebSocket): boolean {
  return heartbeatState.has(socket);
}