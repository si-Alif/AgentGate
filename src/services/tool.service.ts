import {toolRepository} from "../repositories/tool.repository.js";
import {handlerConfigSchema} from "../lib/handler-config.schema.js";
import {validateJsonSchema} from "../lib/schema-validator.js";
import {encryptConfig , decryptConfig} from "../lib/encryption.js";
import type {Prisma , } from "@prisma/client";

export class ValidationError extends Error {
  constructor(
    public code :
      | "INVALID_HANDLER_CONFIG"
      | "INVALID_INPUT_SCHEMA"
      | "INVALID_TOO_COMPLEX"
      | "UNSAFE_SCHEMA_PATTERN",
    public details :unknown
  ){
    super(code);
  }
}

export const toolService = {
  async createTool(
    tenantId : string,
    input : {
      name : string;
      description ?: string;
      category ?: string;
      handlerType : string;
      handlerConfig ?: unknown;
      inputSchema : unknown;
      outputSchema ?: unknown;
    }
  ){
    const parsedConfig = handlerConfigSchema.safeParse({
      ...(input.handlerConfig as object),
      handlerType: input.handlerType,
    });

    if (!parsedConfig.success){
      throw new ValidationError("INVALID_HANDLER_CONFIG", parsedConfig.error.flatten());
    }

    const schemaCheckResult = validateJsonSchema(input.inputSchema as object);

    if(!schemaCheckResult.valid){
      const code =
        schemaCheckResult.failedGate === "structural"
          ? "INVALID_INPUT_SCHEMA"
          : schemaCheckResult.failedGate === "complexity"
            ? "INVALID_TOO_COMPLEX"
            : "UNSAFE_SCHEMA_PATTERN";
      throw new ValidationError(code, schemaCheckResult.errors);
    }

    const encryptedConfig = encryptConfig(JSON.stringify(parsedConfig.data) , tenantId);

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

    try{
      const tool = await toolRepository.create(data);
      return toPublicTool(tool);
    } catch (error : any) {
      if (error.code === "P2002") {
        throw new Error("TOOL_NAME_TAKEN");
      }
      throw error;
    }
  },

  async listTools(tenantId : string){
    const tools = await toolRepository.list(tenantId);
    return tools.map(toPublicTool);
  },

  async getTool(toolId : string, tenantId : string){
    const tool = await toolRepository.findById(toolId, tenantId);
    return tool ? toPublicTool(tool) : null;
  },

  async getDecryptedConfig(id : string,  tenantId : string){
    const tool = await toolRepository.findById(id , tenantId);

    if (!tool) return null;

    const plainText = decryptConfig(tool.handlerConfig , tenantId);

    return JSON.parse(plainText);
  },

  async updateTol(
    id : string ,
    tenantId : string,
    input :{
      name ?: string;
      description ?: string;
      category ?: string;
    }
  ){
    const {count} = await toolRepository.updateProfile(id , tenantId , input);

    if (count === 0) return null;
    return this.getTool(id , tenantId);
  },

  async deactivateTool (id : string , tenantId : string){
    const {count} = await toolRepository.setActiveStatus(id , tenantId , false );

    return count > 0;
  }



}



function toPublicTool(tool : {
  id : string;
  tenantId : string;
  name : string;
  description : string | null;
  category : string | null;
  handlerType : string;
  inputSchema : unknown;
  outputSchema : unknown;
  isActive : boolean;
  createdAt : Date;
  updatedAt : Date;
}){
  const {
    id ,
    tenantId,
    name ,
    description ,
    category ,
    handlerType ,
    inputSchema ,
    outputSchema ,
    isActive ,
    createdAt ,
    updatedAt
  } = tool;

  return tool;
}