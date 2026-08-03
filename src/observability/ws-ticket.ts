import crypto from "node:crypto";
import { rateLimiterRedis } from "../lib/rate-limiter.js";
import { env } from "../config/env.js";
import type { TenantContext } from "../types/fastify.js";

/**
 * A WebSocket observability ticket: a short-lived, single-use, opaque
 * bearer credential that lets an already-authenticated dashboard client
 * open the /observability/stream WebSocket (Day 2) without carrying its
 * JWT into a query string, subprotocol value, or any other place a
 * browser might accidentally log or leak it.
 *
 * Reuses rateLimiterRedis — the same client Week 6's auth-accelerator
 * cache and tools/list cache already share. No new Redis connection is
 * introduced today; the ticket store's failure/health profile is
 * therefore already covered by whatever reports on that client
 * elsewhere (Week 3's circuit breaker, Week 6 Day 5's /health field).
 */

const TICKET_KEY_PREFIX = "ws:ticket";

// Matches Week 2's API-key SECRET generation exactly (crypto.randomBytes,
// not crypto.randomUUID) — a ticket is a genuine bearer credential, not
// a record identifier. This project has never conflated those two
// classes and shouldn't start here. See Day 1 Finding F3.
const TICKET_ID_BYTES = 32;

/**
 * WsTicketPayload IS TenantContext, not a structurally-similar copy of
 * it. A ticket is that same verified identity, externalized into Redis
 * for one round trip — if TenantContext ever gains a field, this gains
 * it automatically, with nothing here to remember to update separately.
 *
 * `role` currently has NO consumer anywhere in Week 7's wire protocol
 * (the connected/event/error frames — Part 4.1 of roadmap_w7.md — never
 * branch on it). Carried for free, forward-compatible, but explicitly
 * INERT until a real consumer exists — same convention as Week 3's
 * agent_tool_permissions.parameterConstraints/callBudgetPerHour. Delete
 * this comment the day something actually reads it, not before.
 */
export type WsTicketPayload = TenantContext;

export interface MintedWsTicket {
  ticket: string;
  expiresInSeconds: number;
}

export function ticketKey(ticketId: string): string {

  return `${TICKET_KEY_PREFIX}:${ticketId}`;
}
export async function redeemWsTicket(ticketId: string): Promise<WsTicketPayload | null> {
  const raw = await rateLimiterRedis.getdel(ticketKey(ticketId));
  if (!raw) return null;
  return JSON.parse(raw) as WsTicketPayload;
}

/**
 * Mints and PERSISTS a single-use ticket. A single Redis SET with EX is
 * already atomic on its own — no Lua script, no pipeline, no reverse
 * index needed (unlike mcp-auth-cache.ts's SET+SADD+EXPIRE, which
 * additionally maintains an invalidation index this ticket store has no
 * equivalent need for: tickets are never proactively revoked — their
 * ≤30s TTL is already far shorter than an access token's own 15-minute
 * lifetime, which this project already treats as an acceptable
 * revocation-latency bound, per Week 1's own "JWTs are stateless — this
 * is correct" stance on logout).
 *
 * Deliberately does NOT store a mint timestamp inside the payload —
 * Redis's own key TTL is already the sole authoritative answer to "how
 * much life does this ticket have left." See Day 1 Finding F4 /
 * Decision 7.27.
 *
 * Any failure to persist is a hard, thrown failure — never a silent
 * fail-open "return a ticket anyway." A ticket the store doesn't
 * actually have is unredeemable by construction, so returning success
 * without a successful write would be categorically wrong, not merely
 * degraded. The caller (the route handler, Step 3) is responsible for
 * mapping this rejection to a 503. See Day 1 Finding F1 / Decision 7.24.
 */
export async function mintWsTicket(identity: WsTicketPayload): Promise<MintedWsTicket> {
  const ticketId = crypto.randomBytes(TICKET_ID_BYTES).toString("base64url");
  const ttlSeconds = env.AGENTGATE_WS_TICKET_TTL_SECONDS;

  await rateLimiterRedis.set(ticketKey(ticketId), JSON.stringify(identity), "EX", ttlSeconds);

  return { ticket: ticketId, expiresInSeconds: ttlSeconds };
}