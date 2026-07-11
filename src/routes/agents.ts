import type { FastifyInstance } from "fastify";
import { agentService } from "../services/agent.service.js";
import { getTenantContext } from "../lib/request-context.js";

const agentResponseProps = {
  id: { type: "string" },
  name: { type: "string" },
  description: { type: ["string", "null"] },  
  isActive: { type: "boolean" },
  createdAt: { type: "string", format: "date-time" },
  updatedAt: { type: "string", format: "date-time" },
} as const;

const agentRequired = ["id", "name", "isActive", "createdAt", "updatedAt"];

export async function agentRoutes(app: FastifyInstance) {
  app.post(
    "/",
    {
      schema: {
        body: {
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string", minLength: 1 },
            description: { type: "string" },
          },
          additionalProperties: false,
        },
        response: {
          201: {
            type: "object",
            required: ["agent", "apiKey"],
            properties: {
              agent: { type: "object", required: agentRequired, properties: agentResponseProps },
              apiKey: { type: "string" },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { tenantId, userId } = getTenantContext(request);
      try {
        const result = await agentService.createAgent(tenantId, userId, request.body as { name: string; description?: string });
        return reply.status(201).send(result);
      } catch (error: any) {
        if (error.message === "AGENT_NAME_TAKEN") {
          return reply.conflict("An agent with this name already exists");
        }
        throw error;
      }
    }
  );

  app.get(
    "/",
    {
      schema: {
        response: {
          200: { type: "array", items: { type: "object", required: agentRequired, properties: agentResponseProps } },
        },
      },
    },
    async (request, reply) => {
      const { tenantId } = getTenantContext(request);
      const agents = await agentService.listAgents(tenantId);
      return reply.status(200).send(agents);
    }
  );

  app.get(
    "/:id",
    {
      schema: {
        params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        response: {
          200: { type: "object", required: agentRequired, properties: agentResponseProps },
        },
      },
    },
    async (request, reply) => {
      const { tenantId } = getTenantContext(request);
      const { id } = request.params as { id: string };
      const agent = await agentService.getAgent(id, tenantId);
      if (!agent) return reply.notFound("Agent not found");
      return reply.status(200).send(agent);
    }
  );

  app.patch(
    "/:id",
    {
      schema: {
        params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        body: {
          type: "object",
          properties: {
            name: { type: "string", minLength: 1 },
            description: { type: "string" },
          },
          additionalProperties: false,
        },
        response: {
          200: { type: "object", required: agentRequired, properties: agentResponseProps },
        },
      },
    },
    async (request, reply) => {
      const { tenantId } = getTenantContext(request);
      const { id } = request.params as { id: string };
      const input = request.body as { name?: string; description?: string };
      const updatedAgent = await agentService.updateAgent(id, tenantId, input);
      if (!updatedAgent) return reply.notFound("Agent not found");
      return reply.status(200).send(updatedAgent);
    }
  );

  app.delete(
    "/:id",
    {
      schema: {
        params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        response: { 204: { type: "null" } },
      },
    },
    async (request, reply) => {
      const { tenantId } = getTenantContext(request);
      const { id } = request.params as { id: string };
      const success = await agentService.deactivateAgent(id, tenantId);
      if (!success) return reply.notFound("Agent not found");
      return reply.status(204).send();
    }
  );

  app.post(
    "/:id/reactivate",
    {
      schema: {
        params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        response: {
          200: { type: "object", required: agentRequired, properties: agentResponseProps },
        },
      },
    },
    async (request, reply) => {
      const { tenantId } = getTenantContext(request);
      const { id } = request.params as { id: string };
      const reactivatedAgent = await agentService.reactivateAgent(id, tenantId);
      if (!reactivatedAgent) return reply.notFound("Agent not found");
      return reply.status(200).send(reactivatedAgent);
    }
  );

  app.post(
    "/:id/rotate-key",
    {
      schema: {
        params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        response: {
          200: { type: "object", required: ["apiKey"], properties: { apiKey: { type: "string" } } },
        },
      },
    },
    async (request, reply) => {
      const { tenantId } = getTenantContext(request);
      const { id } = request.params as { id: string };
      const result = await agentService.rotateAgentKey(id, tenantId);
      if (!result) return reply.notFound("Agent not found");
      return reply.status(200).send(result);
    }
  );
}