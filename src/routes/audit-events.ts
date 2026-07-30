import type { FastifyInstance } from "fastify";
import { getTenantContext } from "../lib/request-context.js";
import { checkRateLimitByKey } from "../lib/rate-limiter.js";
import {
  auditListQuerySchema,
  auditCursorSchema,
} from "../lib/audit-read-schemas.js";
import {
  listAuditEvents,
  getAuditEventDetail,
} from "../repositories/audit-event-read.repository.js";

// --- Reusable JSON Schema Definitions ---

const uuidProp = { type: "string", format: "uuid" } as const;

const auditEventListRowProps = {
  id: { type: "string" },
  eventType: { type: "string" },
  agentId: { type: ["string", "null"] },
  toolId: { type: ["string", "null"] },
  status: { type: ["string", "null"] },
  createdAt: { type: "string", format: "date-time" },
  schemaVersion: { type: "integer" },
  hasInputPreview: { type: "boolean" },
  hasOutputPreview: { type: "boolean" },
  errorMessage: { type: ["string", "null"] },
} as const;

const auditEventRequired = [
  "id",
  "eventType",
  "createdAt",
  "schemaVersion",
  "hasInputPreview",
  "hasOutputPreview",
] as const;

// Standardized Error Response Schemas
const standardErrorResponse = {
  type: "object",
  properties: {
    error: { type: "string" },
    details: { type: "object", additionalProperties: true },
  },
} as const;

const rateLimitErrorResponse = {
  type: "object",
  properties: {
    statusCode: { type: "integer" },
    error: { type: "string" },
    message: { type: "string" },
  },
} as const;

/** Decision 5.46: Lightweight per-user rate limit for read endpoints. */
async function enforceAuditRateLimit(
  request: any,
  reply: any
): Promise<boolean> {
  const { userId } = getTenantContext(request);
  // Shared budget for the audit read path (30 requests/minute)
  const rateLimit = await checkRateLimitByKey(`user:${userId}:audit`, 30);
  if (!rateLimit.allowed) {
    reply.status(429).send({
      statusCode: 429,
      error: "Too Many Requests",
      message: "Rate limit exceeded for audit event queries",
    });
    return false;
  }
  return true;
}

export async function auditEventRoutes(app: FastifyInstance) {

  // --- LIST ENDPOINT ---
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
            agentId: { type: "string", format: "uuid" },
            toolId: { type: "string", format: "uuid" },
          },
        },
        response: {
          200: {
            type: "object",
            required: ["data"],
            properties: {
              data: {
                type: "array",
                items: {
                  type: "object",
                  required: [...auditEventRequired],
                  properties: auditEventListRowProps,
                },
              },
              nextCursor: { type: ["string", "null"] },
            },
          },
          400: standardErrorResponse,
          429: rateLimitErrorResponse,
        },
      },
    },
    async (request, reply) => {
      // 1. Enforce Rate Limit via Helper
      if (!(await enforceAuditRateLimit(request, reply))) return;

      const { tenantId } = getTenantContext(request);

      // 2. Strict Zod Validation for Querystring (Decision 5.39/5.44)
      const parsed = auditListQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "Invalid query parameters",
          details: parsed.error.flatten(),
        });
      }

      // 3. Decode & Validate Opaque Keyset Cursor
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

      // 4. Fetch Paginated Audit Events
      const page = await listAuditEvents(tenantId, parsed.data, cursor);

      return reply.status(200).send(page);
    }
  );

  // --- DETAIL ENDPOINT ---
  app.get(
    "/:id",
    {
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: { id: uuidProp },
        },
        response: {
          200: {
            anyOf: [
              // Shape A: Invocation Event (forensic view with truncation flags & duration)
              {
                type: "object",
                required: ["id", "eventType", "createdAt"],
                properties: {
                  id: { type: "string" },
                  eventType: { type: "string" },
                  agentId: { type: ["string", "null"] },
                  toolId: { type: ["string", "null"] },
                  status: { type: ["string", "null"] },
                  createdAt: { type: "string", format: "date-time" },
                  schemaVersion: { type: "integer" },
                  durationMs: { type: "integer" },
                  hasInputPreview: { type: "boolean" },
                  hasOutputPreview: { type: "boolean" },
                  inputPreview: { type: ["string", "null"] },
                  outputPreview: { type: ["string", "null"] },
                  errorMessage: { type: ["string", "null"] },
                },
              },
              // Shape B: Non-Invocation Event (raw payload view)
              {
                type: "object",
                required: ["id", "eventType", "createdAt"],
                properties: {
                  id: { type: "string" },
                  eventType: { type: "string" },
                  createdAt: { type: "string", format: "date-time" },
                  schemaVersion: { type: "integer" },
                  rawPayload: { type: "object", additionalProperties: true },
                },
              },
            ],
          },
          404: standardErrorResponse,
          429: rateLimitErrorResponse,
        },
      },
    },
    async (request, reply) => {
      // 1. Enforce Rate Limit via Helper (Shared Budget)
      if (!(await enforceAuditRateLimit(request, reply))) return;

      const { tenantId } = getTenantContext(request);
      const { id } = request.params as { id: string };

      // 2. Fetch Detailed Forensic View (Decision 5.43)
      const detail = await getAuditEventDetail(tenantId, id);

      if (!detail) {
        return reply.status(404).send({ error: "Audit event not found" });
      }

      return reply.status(200).send(detail);
    }
  );
}