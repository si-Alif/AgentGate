import { z } from "zod";
import type { WebSocket } from "ws";
import "@fastify/websocket";
import type { FastifyInstance , FastifyRequest } from "fastify";
import { isOriginAllowed } from "../mcp/http/origin-validator.js";
import { mintWsTicket } from "../observability/ws-ticket.js";
import { checkRateLimitByNameSpace } from "../lib/rate-limiter.js";
import { env } from "../config/env.js";
import { getTenantContext } from "../lib/request-context.js";
import { redeemWsTicket } from "../observability/ws-ticket.js";
import type { WsTicketPayload } from "../observability/ws-ticket.js";
import { registerConnection, deregisterConnection } from "../observability/ws-connection-tracker.js";
import { rejectConnection, sendConnectedFrame, WS_CLOSE_CODE } from "../observability/ws-protocol.js";
import { registerTenantViewer, deregisterTenantViewer } from "../observability/ws-tenant-registry.js";

const WS_TICKET_RATE_NAMESPACE = "ws-ticket";
const CONNECT_RATE_NAMESPACE = "ws-stream-connect";

const wsStreamQuerySchema = z.object({
  ticket: z.string().min(1),
});


/**
 * Registered INSIDE the existing protected REST scope in app.ts —
 * inherits authenticate -> attachTenantContext -> requireActiveIdentity
 * via Fastify's hook inheritance, the same convention every other
 * protected route has used since Week 2 (agentRoutes, toolRoutes,
 * permissionRoutes, auditEventRoutes). Do NOT re-add those hooks here.
 *
 * CONFIRM AT IMPLEMENTATION TIME (Day 1 Finding F7 / Decision 7.30): a
 * direct read of app.ts to confirm this scope genuinely applies
 * requireActiveIdentity (or your project's equivalent tenant/user
 * liveness re-check), not just authenticate + attachTenantContext. Per
 * Week 6 Day 2's own review of the identical gap on the MCP side: "the
 * JWT-side soft-delete hook... only guards the human-user REST scope."
 * This route IS on that scope, so it should already be covered — but
 * that's worth confirming by reading the file, not assuming.
 *
 * Day 2 extends this SAME file with the GET /stream WS upgrade handler
 * — that route deliberately does NOT live in this protected scope,
 * since its auth model is ticket redemption, not a JWT header.
 */
export async function observabilityRoutes(app: FastifyInstance) {
  app.post(
    "/ticket",
    {
      schema: {
        // No request body — this POST carries no input beyond the
        // Authorization header, matching the empty-body convention
        // already used by e.g. POST /agents/:id/rotate-key (Week 2).
        response: {
          // Day 1 Finding F6 / Decision 7.29 — an explicit, minimal
          // response schema.
          200: {
            type: "object",
            properties: {
              ticket: { type: "string" },
              expiresInSeconds: { type: "number" },
            },
            required: ["ticket", "expiresInSeconds"],
          },
          // Define 429 so the TS compiler allows reply.status(429).send(...)
          429: {
            type: "object",
            properties: {
              statusCode: { type: "number" },
              error: { type: "string" },
              message: { type: "string" },
            },
            required: ["statusCode", "error", "message"],
          },
          // Define 503 so the TS compiler allows reply.status(503).send(...)
          503: {
            type: "object",
            properties: {
              statusCode: { type: "number" },
              error: { type: "string" },
              message: { type: "string" },
            },
            required: ["statusCode", "error", "message"],
          }
        },
      },
    },
    async (request, reply) => {
      const { userId, tenantId } = getTenantContext(request);

      // Day 1 Finding F8 / Decision 7.31 — tenantId folded into the
      // rate-limit IDENTITY string, not passed as a separate parameter.
      // checkRateLimitByNameSpace's real signature is (namespace,
      // identifier, limit) with no dedicated tenantId slot the way
      // checkRateLimit(agentId, limit, tenantId?) has had since Week 6
      // Day 5. userId alone already guarantees uniqueness (global UUID
      // PK, Week 1) — this is purely for SCAN-by-tenant operational
      // visibility, mirroring Week 6 Day 5 Decision 5.10 exactly.
      const rateLimitIdentity = `${tenantId}:${userId}`;

      const rateLimitResult = await checkRateLimitByNameSpace(
        WS_TICKET_RATE_NAMESPACE,
        rateLimitIdentity,
        env.AGENTGATE_WS_TICKET_ISSUE_RATE_LIMIT
      );

      if (!rateLimitResult.allowed) {
        // Day 1 Finding F1 / Decision 7.24 — the fifth occurrence of
        // this project's standing rule: an infra fault is never
        // reported as a policy denial.
        if (rateLimitResult.degraded) {
          return reply.status(503).send({
            statusCode: 503,
            error: "service_degraded",
            message: "Ticket issuance is temporarily degraded. Retry shortly.",
          });
        }
        return reply.status(429).send({
          statusCode: 429,
          error: "rate_limited",
          message: "Too many ticket requests. Retry after your rate limit window resets.",
        });
      }

      try {
        const minted = await mintWsTicket(getTenantContext(request));
        return reply.status(200).send(minted);
      } catch (err) {
        request.log.error({ err }, "Failed to persist WS observability ticket");
        // Finding F1 / Decision 7.24, second half — a write failure
        // AFTER a passed rate check is also a hard failure, never a
        // silently-issued, unredeemable ticket.
        return reply.status(503).send({
          statusCode: 503,
          error: "Service Unavailable",
          message: "Ticket issuance is temporarily degraded. Retry shortly.",
        });
      }
    }
  );
}


/**
 * GET /observability/stream — the ticket-authenticated WebSocket
 * upgrade. Registered PUBLICLY (no authenticate/attachTenantContext/
 * requireActiveIdentity hooks) — its entire auth model is ticket
 * redemption, proven by Day 1's issuance endpoint, not a Bearer JWT.
 *
 * EVERY rejection this handler can produce completes the WS handshake
 * first, then closes deliberately with a documented application code
 * (Decision 7.34 / Finding F3) — a browser's native WebSocket API
 * cannot read an HTTP-level rejection's status code or body, only a
 * generic, undiagnosable 1006. There is no pre-upgrade hook anywhere
 * in this file for exactly that reason.
 */
export async function observabilityStreamRoutes(app: FastifyInstance) {
  app.get("/stream", { websocket: true }, (socket, request) => {
    void handleStreamUpgrade(socket, request);
  });
}

async function handleStreamUpgrade(socket: WebSocket, request: FastifyRequest): Promise<void> {
  try {
    // 1. Origin — free, synchronous. Checked first: cheapest possible
    //    rejection, before anything that touches Redis. Reused
    //    UNCHANGED from Week 6 Day 2 — same allow-list env var, no
    //    second, parallel Origin config to drift out of sync.
    if (!isOriginAllowed(request.headers.origin)) {
      rejectConnection(socket, WS_CLOSE_CODE.ORIGIN_NOT_ALLOWED);
      return;
    }

    // 2. Ticket presence/format — free, synchronous. A request with no
    //    ticket parameter at all never touches Redis for ANYTHING,
    //    including the connect-throttle below.
    const parsedQuery = wsStreamQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) {
      rejectConnection(socket, WS_CLOSE_CODE.TICKET_INVALID);
      return;
    }
    const ticketId = parsedQuery.data.ticket;

    // 3. Coarse, PRE-REDEMPTION, IP-keyed connect-attempt throttle
    //    (Decision 7.39-7.40 / Finding F7). Bounds the volume of
    //    expensive GETDEL calls a flood of well-formed-but-garbage
    //    tickets can trigger. No userId exists yet at this point —
    //    that's what redemption is FOR — so IP is the only available
    //    identity, exactly mirroring Week 6 Day 2's own pre-auth
    //    coarse throttle for the structurally identical problem on
    //    /mcp.
    const connectRateLimit = await checkRateLimitByNameSpace(
      CONNECT_RATE_NAMESPACE,
      request.ip,
      env.AGENTGATE_WS_STREAM_CONNECT_RATE_LIMIT
    );
    if (!connectRateLimit.allowed) {
      rejectConnection(
        socket,
        connectRateLimit.degraded ? WS_CLOSE_CODE.SERVICE_DEGRADED : WS_CLOSE_CODE.TOO_MANY_CONNECTION_ATTEMPTS
      );
      return;
    }

    // 4. Ticket redemption — atomic GETDEL, three outcomes (Decision 7.32).
    let identity: WsTicketPayload | null;
    try {
      identity = await redeemWsTicket(ticketId);
    } catch (err) {
      request.log.error({ err }, "[observability-stream] ticket redemption failed (infra fault)");
      rejectConnection(socket, WS_CLOSE_CODE.SERVICE_DEGRADED);
      return;
    }
    if (identity === null) {
      rejectConnection(socket, WS_CLOSE_CODE.TICKET_INVALID);
      return;
    }

    // 5. Per-user, per-replica connection ceiling — free, synchronous
    //    (Decision 7.37). MUST come after redemption: userId doesn't
    //    exist until the ticket resolves an identity.
    const resolvedIdentity = identity;
    const { registered } = registerConnection(resolvedIdentity.userId, socket);
    if (!registered) {
      rejectConnection(socket, WS_CLOSE_CODE.CONNECTION_CEILING_EXCEEDED);
      return;
    }

    // Single cleanup authority for THIS module's state. .once(), not
    // .on() — exact-once semantics, matching the established
    // convention from request-abort.ts (Week 6 Day 2).
    socket.once("close", () => {
      deregisterConnection(resolvedIdentity.userId, socket);
    });

    // Once a client observes `connected`, it
    // is already eligible to receive any event published from this
    // instant forward.
    registerTenantViewer(resolvedIdentity.tenantId, socket);

    // A SECOND, fully independent .once("close", ...) listener
    //  — deliberately NOT merged
    // with the ceiling-tracker listener above. The two subsystems own
    // disjoint state with no ordering dependency, and each is
    // independently idempotent.
    socket.once("close", () => {
      deregisterTenantViewer(resolvedIdentity.tenantId, socket);
    });

    sendConnectedFrame(socket, resolvedIdentity.tenantId);
    // Day 4 adds a bufferedAmount backpressure gate around
    // ws-tenant-registry.ts's existing fan-out send call site, plus
    // native ping/pong heartbeating. Day 5 wires this week's one new
    // Redis connection (tenantEventSubscriber) into /health and
    // server.ts's shutdown sequence.
  } catch (err) {
    request.log.error({ err }, "[observability-stream] unexpected failure during upgrade");
    rejectConnection(socket, WS_CLOSE_CODE.SERVICE_DEGRADED);
  }
}