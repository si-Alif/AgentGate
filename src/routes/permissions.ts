import type { FastifyInstance } from "fastify";
import { permissionService, PermissionValidationError } from "../services/permission.service.js";
import { agentService } from "../services/agent.service.js";
import { getTenantContext } from "../lib/request-context.js";

/**
 * Registered INSIDE the existing protected scope in app.ts, under the
 * SAME static prefix as agentRoutes ("/api/agents") — these routes
 * define their own ":agentId/permissions" sub-path rather than a
 * parametric register() prefix, mirroring roadmap_w3.md Day 2 Step 4.
 * Do not re-add authenticate/attachTenantContext/requireActiveIdentity
 * hooks here — they're inherited from the parent scope.
 *
 * tenantId is read via getTenantContext(request), not
 * request.tenantContext directly, matching the real accessor pattern
 * established in tools.ts/app.ts.
 */

const permissionResponseProps = {
  id: { type: "string" },
  agentId: { type: "string" },
  toolId: { type: "string" },
  isActive: { type: "boolean" },
  // Phase 2 stub columns (PRD §10) — present in the schema but NOT
  // read or enforced by any Week 3 code path. Always null today.
  // Kept nullable here so a future non-null Phase 2 write doesn't
  // break response serialization the day enforcement actually lands.
  parameterConstraints: { type: ["object", "null"] },
  callBudgetPerHour: { type: ["integer", "null"] },
  createdAt: { type: "string", format: "date-time" },
  updatedAt: { type: "string", format: "date-time" },
  // tenantId is DELIBERATELY omitted — matches the real toolResponseProps
  // convention in tools.ts (the client already knows its own tenant from
  // its JWT; fast-json-stringify drops any field not listed here, so the
  // service can keep returning the raw Prisma row without a dedicated
  // toPublicPermission() sanitizer).
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

export async function permissionRoutes(app: FastifyInstance) {
  app.post(
    "/:agentId/permissions",
    {
      schema: {
        params: {
          type: "object",
          required: ["agentId"],
          properties: { agentId: { type: "string" } },
        },
        body: {
          type: "object",
          required: ["toolId"],
          properties: { toolId: { type: "string" } },
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
          properties: { agentId: { type: "string" } },
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

      // Explicit existence check rather than letting an unknown or
      // foreign-tenant agentId silently fall through to "200 []".
      // listPermissions() only filters agent_tool_permissions by
      // (agentId, tenantId) — it has no way to distinguish "this
      // agent exists and has zero grants" from "this agent doesn't
      // belong to you" on its own. Same collapsing-into-one-response
      // philosophy as Week 2's agent/tool updateById, applied here
      // as 404 instead of a misleading empty list.
      const agent = await agentService.getAgent(agentId, tenantId);
      if (!agent) {
        return reply.notFound("Agent not found");
      }

      const result = await permissionService.listPermissions(tenantId, agentId);
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
            agentId: { type: "string" },
            toolId: { type: "string" },
          },
        },
        response: {
          204: { type: "null" },
        },
      },
    },
    async (request, reply) => {
      const { tenantId } = getTenantContext(request);
      const { agentId, toolId } = request.params as { agentId: string; toolId: string };
      const revoked = await permissionService.revokePermission(tenantId, agentId, toolId);
      if (!revoked) {
        // Collapses "agent not found", "tool not found", and "no
        // active grant exists" into one 404 — consistent with
        // revokePermission()'s own updateMany-count-based check,
        // which can't distinguish those cases either (Week 2's
        // established "same response either way" precedent).
        return reply.notFound("Permission grant not found");
      }
      return reply.status(204).send();
    }
  );
}