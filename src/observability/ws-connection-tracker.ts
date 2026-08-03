import type { WebSocket } from "ws";
import { env } from "../config/env.js";

/**
 * Per-user, PER-REPLICA (Decision 7.18, roadmap_w7.md — not
 * cluster-wide) concurrent WebSocket connection ceiling for
 * /observability/stream.
 *
 * Pure in-process state — same nature as the old, retired Session Map:
 * correctly rebuilt from nothing on every process restart, no
 * persistence needed or wanted (Decision 7.22). Zero shutdown handling
 * required either — there is nothing external to release, only local
 * references that vanish with the process.
 *
 * Deliberately NOT the same structure as Day 3's upcoming tenant-
 * channel registry (Map<tenantId, Set<WebSocket>>), even though the
 * value shape echoes it (Finding F5 / Decision 7.37) — this one is
 * keyed by userId (ceiling is a per-USER limit, checked before any
 * tenant-channel concern exists), Day 3's will be keyed by tenantId
 * (fan-out is a per-TENANT concern). Two different axes, two
 * different maps, each owning only its own concern — mirrors this
 * project's standing preference for narrow, single-purpose modules
 * (mcp-auth-cache.ts vs. tools-list-cache.ts, Week 6) over one
 * overloaded structure trying to answer two questions.
 */

const connectionsByUser = new Map<string, Set<WebSocket>>();

export interface RegisterResult {
  registered: boolean;
  currentCount: number;
}

/**
 * Synchronous, check-then-add in a single tick. Node's event loop
 * means there is never an `await` between the ceiling check and the
 * Set mutation, so two "simultaneous" connection attempts are still
 * processed one full synchronous turn at a time — no race is
 * possible. Same reasoning this project already relied on for the
 * circuit breaker's canAttempt()-before-await ordering (Week 3),
 * stated explicitly here rather than left implicit.
 */
export function registerConnection(userId: string, socket: WebSocket): RegisterResult {
  const existing = connectionsByUser.get(userId);
  const currentCount = existing?.size ?? 0;

  if (currentCount >= env.AGENTGATE_WS_MAX_CONNECTIONS_PER_USER) {
    return { registered: false, currentCount };
  }

  if (existing) {
    existing.add(socket);
  } else {
    connectionsByUser.set(userId, new Set([socket]));
  }

  return { registered: true, currentCount: currentCount + 1 };
}

/**
 * The single cleanup authority for THIS module's state (Day 3 owns an
 * independent, equivalent authority for its own registry — see the
 * module docstring above). Idempotent: deregistering a socket that was
 * never registered, or was already deregistered, is a safe no-op —
 * required because a REJECTED connection's own socket.close() call
 * (fired from rejectConnection(), before registration ever happens)
 * can still trigger a native 'close' event later; nothing here assumes
 * registration always preceded deregistration.
 */
export function deregisterConnection(userId: string, socket: WebSocket): void {
  const existing = connectionsByUser.get(userId);
  if (!existing) return;
  existing.delete(socket);
  if (existing.size === 0) {
    connectionsByUser.delete(userId);
  }
}

/** Diagnostic-only accessor — never consulted on a request-handling path. */
export function getActiveConnectionCount(userId: string): number {
  return connectionsByUser.get(userId)?.size ?? 0;
}

/** Test-only: full reset between test cases. Never called in production. */
export function resetAllConnectionsForTest(): void {
  connectionsByUser.clear();
}