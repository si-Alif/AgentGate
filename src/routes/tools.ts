import type { FastifyInstance } from "fastify";
import { toolService, ValidationError } from "../services/tool.service.js";
import { getTenantContext } from "../lib/request-context.js";

const toolResponseProps = {
  id: { type: "string" },
  name: { type: "string" },
  description: { type: ["string", "null"] },
  category: { type: ["string", "null"] },
  handlerType: { type: "string" },
  inputSchema: { type: "object" },
  outputSchema: { type: ["object", "null"] },
  isActive: { type: "boolean" },
  createdAt: { type: "string", format: "date-time" },
  updatedAt: { type: "string", format: "date-time" },
} as const;

const toolRequired = [
  "id",
  "name",
  "description",
  "category",
  "handlerType",
  "inputSchema",
  "outputSchema",
  "isActive",
  "createdAt",
  "updatedAt",
] as const;

export async function toolRoutes(app: FastifyInstance) {
  app.post(
    "/",
    {
      schema: {
        body: {
          type: "object",
          required: ["name", "handlerType", "handlerConfig", "inputSchema"],
          properties: {
            name: { type: "string", minLength: 1 },
            description: { type: "string" },
            category: { type: "string" },
            handlerType: { type: "string" },
            handlerConfig: { type: "object" },
            inputSchema: { type: "object" },
            outputSchema: { type: "object" },
          },
          additionalProperties: false,
        },
        response: {
          201: {
            type: "object",
            required: [...toolRequired],
            properties: toolResponseProps,
          },
        },
      },
    },
    async (request, reply) => {
      const { tenantId } = getTenantContext(request);
      try {
        const result = await toolService.createTool(tenantId, request.body as { name: string; description?: string; category?: string; handlerType: string; handlerConfig: unknown; inputSchema: unknown; outputSchema?: unknown });
        return reply.status(201).send(result);
      } catch (err) {
        if (err instanceof ValidationError) {
          return reply.badRequest(JSON.stringify({ code: err.code, details: err.details }));
        }
        if (err instanceof Error && err.message === "TOOL_NAME_TAKEN") {
          return reply.conflict("A tool with this name already exists in this tenant");
        }
        throw err;
      }
    }
  );

  app.get(
    "/",
    {
      schema: {
        response: {
          200: {
            type: "array",
            items: {
              type: "object",
              required: [...toolRequired],
              properties: toolResponseProps,
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { tenantId } = getTenantContext(request);
      try {
        const result = await toolService.listTools(tenantId);
        return reply.status(200).send(result);
      } catch (err) {
        throw err;
      }
    }
  );

  app.get(
    "/:id",
    {
      schema: {
        params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        response: {
          200: {
            type: "object",
            required: [...toolRequired],
            properties: toolResponseProps,
          },
        },
      },
    },
    async (request, reply) => {
      const { tenantId } = getTenantContext(request);
      const { id } = request.params as { id: string };
      try {
        const result = await toolService.getTool(id, tenantId);
        if (!result) {
          return reply.notFound("Tool not found");
        }
        return reply.status(200).send(result);
      } catch (err) {
        throw err;
      }
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
            category: { type: "string" },
          },
          additionalProperties: false,
        },
        response: {
          200: {
            type: "object",
            required: [...toolRequired],
            properties: toolResponseProps,
          },
        },
      },
    },
    async (request, reply) => {
      const { tenantId } = getTenantContext(request);
      const { id } = request.params as { id: string };
      try {
        const result = await toolService.updateTool(id, tenantId, request.body as { name?: string; description?: string; category?: string });
        if (!result) {
          return reply.notFound("Tool not found");
        }
        return reply.status(200).send(result);
      } catch (err) {
        if (err instanceof ValidationError) {
          return reply.badRequest(JSON.stringify({ code: err.code, details: err.details }));
        }
        if (err instanceof Error && err.message === "TOOL_NAME_TAKEN") {
          return reply.conflict("A tool with this name already exists in this tenant");
        }
        throw err;
      }
    }
  );

  app.delete(
    "/:id",
    {
      schema: {
        params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        response: {
          204: { type: "null" },
        },
      },
    },
    async (request, reply) => {
      const { tenantId } = getTenantContext(request);
      const { id } = request.params as { id: string };
      try {
        const result = await toolService.deactivateTool(id, tenantId);
        if (!result) {
          return reply.notFound("Tool not found");
        }
        return reply.status(204).send();
      } catch (err) {
        throw err;
      }
    }
  )

}