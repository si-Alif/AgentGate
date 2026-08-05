import type { FastifyInstance } from "fastify";
import { invitationService, EmailAlreadyRegisteredError } from "../services/invitation.service.js";
import { requireRole } from "../plugins/authorize.js";
import { checkRateLimitByNameSpace } from "../lib/rate-limiter.js";
import { env } from "../config/env.js";
import { VALID_ROLES } from "../lib/roles.js";
import { getTenantContext } from "../lib/request-context.js";

const INVITATION_ISSUE_RATE_NAMESPACE = "invitation-issue";


export async function invitationRoutes(app: FastifyInstance) {
  app.post(
    "/invitations",
    {
      preHandler: [requireRole("owner")],
      schema: {
        body: {
          type: "object",
          required: ["email"],
          properties: {
            email: { type: "string", format: "email" },
            role: { type: "string", enum: [...VALID_ROLES] },
          },
          additionalProperties: false,
        },
        response: {
          201: {
            type: "object",
            properties: {
              id: { type: "string" },
              email: { type: "string" },
              role: { type: "string" },
              expiresAt: { type: "string" },
              // Deliberately no `token` field in this schema — the
              // raw token is never returned via the API (Decision:
              // email delivery only). Serialization enforces this the
              // same way Week 1 Day 3's response schema has kept
              // passwordHash out of every auth response since Day 3.
            },
          },
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
      const { tenantId, userId } = getTenantContext(request);
      const body = request.body as { email: string; role?: "owner" | "member" };
      const role = body.role ?? "member";

      const rateLimitResult = await checkRateLimitByNameSpace(
        INVITATION_ISSUE_RATE_NAMESPACE,
        `${tenantId}:${userId}`,
        env.AGENTGATE_INVITATION_ISSUE_RATE_LIMIT
      );
      if (!rateLimitResult.allowed) {
        if (rateLimitResult.degraded) {
          return reply.status(503).send({
            statusCode: 503,
            error: "service_degraded",
            message: "Invitation issuance is temporarily degraded. Retry shortly.",
          });
        }
        return reply.status(429).send({
          statusCode: 429,
          error: "rate_limited",
          message: "Too many invitations issued. Retry after your rate limit window resets.",
        });
      }

      try {
        const { invitation } = await invitationService.createInvitation(tenantId, userId, { email: body.email, role });
        return reply.status(201).send(invitation);
      } catch (err) {
        if (err instanceof EmailAlreadyRegisteredError) {
          return reply.conflict("A user with this email already exists.");
        }
        throw err;
      }
    }
  );
}