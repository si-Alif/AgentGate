import type { FastifyInstance } from "fastify";
import { getTenantContext } from "../lib/request-context.js";
import { checkRateLimitByKey } from "../lib/rate-limiter.js";
import { listAuditEvents, getAuditEventDetail } from "../repositories/audit-event-read.repository.js";
import { auditListQuerySchema, auditCursorSchema } from "../lib/audit-read-schemas.js";

export async function auditEventRoutes(app: FastifyInstance) {
  // ── shared rate limiter helper ────────────────────────────────────
  async function enforceAuditRateLimit(request: any, reply: any): Promise<boolean> {
    const { userId } = getTenantContext(request);
    const rateLimitResult = await checkRateLimitByKey(userId, 30);
    if (!rateLimitResult.allowed) {
      if (rateLimitResult.degraded) {
        return reply.status(503).send({
          statusCode: 503,
          error: "service_degraded",
          message: "Audit event listing is temporarily degraded. Retry shortly.",
        });
      }
      reply.status(429).send({
        statusCode: 429,
        error: "rate_limited",
        message: "Too many requests. Retry after your rate limit window resets.",
      });
      return false;
    }
    return true;
  }

  // ── GET / (list) ───────────────────────────────────────────────────
  app.get(
    "/",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            limit: { type: "integer", default: 25, minimum: 1, maximum: 50 },
            cursor: { type: "string" },
            eventType: { type: "string" },
            status: { type: "string" },
            agentId: { type: "string" },
            toolId: { type: "string" },
            since : { type: "string", format: "date-time" },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      if (!(await enforceAuditRateLimit(request, reply))) return;

      const { tenantId } = getTenantContext(request);

      const parsed = auditListQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "Invalid query parameters",
          details: parsed.error.flatten(),
        });
      }

      let cursor: { createdAt: number; id: string } | undefined;
      if (parsed.data.cursor) {
        try {
          const raw = JSON.parse(
            Buffer.from(parsed.data.cursor, "base64url").toString("utf-8")
          );
          const validated = auditCursorSchema.safeParse(raw);
          if (!validated.success) {
            return reply.status(400).send({ error: "Malformed cursor" });
          }
          cursor = validated.data;
        } catch {
          return reply.status(400).send({ error: "Malformed cursor" });
        }
      }

      const page = await listAuditEvents(tenantId, parsed.data, cursor);
      return reply.status(200).send(page);
    }
  );

  // ── GET /:id (detail) ──────────────────────────────────────────────
  app.get(
    "/:id",
    {
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
      },
    },
    async (request, reply) => {
      if (!(await enforceAuditRateLimit(request, reply))) return;

      const { tenantId , userId } = getTenantContext(request);

      const rateLimitResult = await checkRateLimitByKey(userId, 30);
      if (!rateLimitResult.allowed) {
        if (rateLimitResult.degraded) {
          return reply.status(503).send({
            statusCode: 503,
            error: "service_degraded",
            message: "Audit event detail retrieval is temporarily degraded. Retry shortly.",
          });
        }
        reply.status(429).send({
          statusCode: 429,
          error: "rate_limited",
          message: "Too many requests. Retry after your rate limit window resets.",
        });
        return;
      }
      
      const { id } = request.params as { id: string };
      const detail = await getAuditEventDetail(tenantId, id);
      if (!detail) {
        return reply.status(404).send({ error: "Audit event not found" });
      }

      return reply.status(200).send(detail);
    }
  );
}