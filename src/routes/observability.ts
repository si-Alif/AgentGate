import type { FastifyInstance } from "fastify";
import { mintWsTicket } from "../observability/ws-ticket.js";
import { checkRateLimitByNameSpace } from "../lib/rate-limiter.js";
import { env } from "../config/env.js";
import { getTenantContext } from "../lib/request-context.js";

const WS_TICKET_RATE_NAMESPACE = "ws-ticket";

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