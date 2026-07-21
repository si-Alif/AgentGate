import type { FastifyInstance } from "fastify";
import { permissionService, PermissionValidationError } from "../services/permission.service.js";
import { agentService } from "../services/agent.service.js";
import { getTenantContext } from "../lib/request-context.js";
import { checkRateLimitByKey } from "../lib/rate-limiter.js";


const uuidProp = { type: "string", format: "uuid" } as const;

const permissionResponseProps = {
  id: { type: "string" },
  agentId: { type: "string" },
  toolId: { type: "string" },
  isActive: { type: "boolean" },
  // Phase 2 stub columns (PRD §10) — present in the schema but NOT
  // read or enforced by any Week 3 code path. Always null today.
  parameterConstraints: { type: ["object", "null"] },
  callBudgetPerHour: { type: ["integer", "null"] },
  createdAt: { type: "string", format: "date-time" },
  updatedAt: { type: "string", format: "date-time" },
} as const;

const permissionRequired = [
  "id",
  "agentId",
  "toolId",
  "isActive",
  "parameterConstraints",
  "callBudgetPerHour",
  "createdAt",
  "updatedAt",
] as const;

/** FINDING 6: Lightweight per-user rate limit for mutation endpoints. */
async function enforcePermissionRateLimit(
  request: any,
  reply: any
): Promise<boolean> {
  const { userId } = getTenantContext(request);
  const rateLimit = await checkRateLimitByKey(`user:${userId}:permissions`, 30);
  if (!rateLimit.allowed) {
    reply.status(429).send({
      statusCode: 429,
      error: "Too Many Requests",
      message: "Rate limit exceeded for permission management",
    });
    return false;
  }
  return true;
}

export async function permissionRoutes(app: FastifyInstance) {
  app.post(
    "/:agentId/permissions",
    {
      schema: {
        params: {
          type: "object",
          required: ["agentId"],
          properties: { agentId: uuidProp },
        },
        body: {
          type: "object",
          required: ["toolId"],
          properties: { toolId: uuidProp },
          additionalProperties: false,
        },
        response: {
          201: {
            type: "object",
            required: [...permissionRequired],
            properties: permissionResponseProps,
          },
        },
      },
    },
    async (request, reply) => {
      if (!(await enforcePermissionRateLimit(request, reply))) return;

      const { tenantId } = getTenantContext(request);
      const { agentId } = request.params as { agentId: string };
      const { toolId } = request.body as { toolId: string };
      try {
        const permission = await permissionService.assignPermission(tenantId, { agentId, toolId });
        return reply.status(201).send(permission);
      } catch (err) {
        if (err instanceof PermissionValidationError) {
          if (err.code === "AGENT_OR_TOOL_NOT_FOUND") {
            return reply.notFound("Agent or tool not found in this tenant");
          }
          if (err.code === "PERMISSION_ALREADY_EXISTS") {
            return reply.conflict("This agent already has a permission grant for this tool");
          }
        }
        throw err;
      }
    }
  );

  app.get(
    "/:agentId/permissions",
    {
      schema: {
        params: {
          type: "object",
          required: ["agentId"],
          properties: { agentId: uuidProp },
        },
        querystring: {
          type: "object",
          properties: {
            limit: { type: "integer", default: 50, minimum: 1, maximum: 100 },
            offset: { type: "integer", default: 0, minimum: 0 },
          },
        },
        response: {
          200: {
            type: "array",
            items: {
              type: "object",
              required: [...permissionRequired],
              properties: permissionResponseProps,
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { tenantId } = getTenantContext(request);
      const { agentId } = request.params as { agentId: string };
      const { limit, offset } = request.query as { limit?: number; offset?: number };

      const agent = await agentService.getAgent(agentId, tenantId);
      if (!agent) {
        return reply.notFound("Agent not found");
      }

      const result = await permissionService.listPermissions(tenantId, agentId, {
        limit: limit ?? 50,
        offset: offset ?? 0,
      });
      return reply.status(200).send(result);
    }
  );

  app.delete(
    "/:agentId/permissions/:toolId",
    {
      schema: {
        params: {
          type: "object",
          required: ["agentId", "toolId"],
          properties: {
            agentId: uuidProp,
            toolId: uuidProp,
          },
        },
        response: {
          204: { type: "null" },
        },
      },
    },
    async (request, reply) => {
      if (!(await enforcePermissionRateLimit(request, reply))) return;

      const { tenantId } = getTenantContext(request);
      const { agentId, toolId } = request.params as { agentId: string; toolId: string };
      const revoked = await permissionService.revokePermission(tenantId, agentId, toolId);
      if (!revoked) {
        return reply.notFound("Permission grant not found");
      }
      return reply.status(204).send();
    }
  );
}