import type { Prisma, } from "@prisma/client";


import { toolRepository } from "../repositories/tool.repository.js";
import { handlerConfigSchema } from "../lib/handler-config.schema.js";
import { validateJsonSchema } from "../lib/schema-validator.js";
import { encryptConfig, decryptConfig } from "../lib/encryption.js";
import { invalidateTenantToolsListCache } from "../mcp/tools/tools-list-cache.js";


export class ValidationError extends Error {
  constructor(
    public code:
      | "INVALID_HANDLER_CONFIG"
      | "INVALID_INPUT_SCHEMA"
      | "INVALID_TOO_COMPLEX"
      | "UNSAFE_SCHEMA_PATTERN",
    public details: unknown
  ) {
    super(code);
  }
}

export const toolService = {
  async createTool(
    tenantId: string,
    input: {
      name: string;
      description?: string;
      category?: string;
      handlerType: string;
      handlerConfig?: unknown;
      inputSchema: unknown;
      outputSchema?: unknown;
    }
  ) {
    const parsedConfig = handlerConfigSchema.safeParse({
      ...(input.handlerConfig as object),
      handlerType: input.handlerType,
    });

    if (!parsedConfig.success) {
      throw new ValidationError("INVALID_HANDLER_CONFIG", parsedConfig.error.flatten());
    }

    const schemaCheckResult = validateJsonSchema(input.inputSchema as object);

    if (!schemaCheckResult.valid) {
      const code =
        schemaCheckResult.failedGate === "structural"
          ? "INVALID_INPUT_SCHEMA"
          : schemaCheckResult.failedGate === "complexity"
            ? "INVALID_TOO_COMPLEX"
            : "UNSAFE_SCHEMA_PATTERN";
      throw new ValidationError(code, schemaCheckResult.errors);
    }

    const encryptedConfig = encryptConfig(JSON.stringify(parsedConfig.data), tenantId);

    const data = {
      tenantId,
      name: input.name,
      handlerType: parsedConfig.data.handlerType as string,
      handlerConfig: encryptedConfig,
      inputSchema: input.inputSchema as Prisma.InputJsonValue,
      ...(input.description !== undefined && { description: input.description }),
      ...(input.category !== undefined && { category: input.category }),
      ...(input.outputSchema !== undefined && { outputSchema: input.outputSchema as Prisma.InputJsonValue }),
    };

    try {
      const tool = await toolRepository.create(data);
      return toPublicTool(tool);
    } catch (error: any) {
      if (error.code === "P2002") {
        throw new Error("TOOL_NAME_TAKEN");
      }
      throw error;
    }
  },

  async listTools(tenantId: string) {
    const tools = await toolRepository.list(tenantId);
    return tools.map(toPublicTool);
  },

  async getTool(toolId: string, tenantId: string) {
    const tool = await toolRepository.findById(toolId, tenantId);
    return tool ? toPublicTool(tool) : null;
  },

  async getDecryptedConfig(id: string, tenantId: string) {
    const tool = await toolRepository.findById(id, tenantId);

    if (!tool) return null;

    const plainText = decryptConfig(tool.handlerConfig, tenantId);

    return JSON.parse(plainText);
  },

  async updateTool(
    id: string,
    tenantId: string,
    input: {
      name?: string;
      description?: string;
      category?: string;
    }
  ) {
    const { count } = await toolRepository.updateProfile(id, tenantId, input);

    if (count === 0) return null;
    return this.getTool(id, tenantId);
  },

  async deactivateTool(id: string, tenantId: string) {

    // find the tool
    const { count } = await toolRepository.setActiveStatus(id, tenantId, false);

    // for MVP scope , if a tool is deactivated  , we'll remove all the cached permission list for agents under that entire particular tenant instead of trying to find out which agents had a grant to this tool and only remove their cached permission list . This is because the permission table is a join table and we don't have a direct index on toolId to find out which agents had a grant to this tool . So for MVP scope , we'll just remove all the cached permission list for all agents under that tenantId
    if (count > 0) {
      await invalidateTenantToolsListCache(tenantId);
    }

    return count > 0;
  }



}



function toPublicTool(tool: {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  handlerType: string;
  inputSchema: unknown;
  outputSchema: unknown;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}) {
  const {
    id,
    name,
    description,
    category,
    handlerType,
    inputSchema,
    outputSchema,
    isActive,
    createdAt,
    updatedAt
  } = tool;

  return {
    id, name, description, category, handlerType,
    inputSchema, outputSchema, isActive, createdAt, updatedAt
  };
}