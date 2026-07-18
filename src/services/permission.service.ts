import { permissionRepository } from "../repositories/permission.repository.js";
import { agentRepository } from "../repositories/agent.repository.js";
import { toolRepository } from "../repositories/tool.repository.js";

export type PermissionErrorCode = "AGENT_OR_TOOL_NOT_FOUND" | "PERMISSION_ALREADY_EXISTS";


export class PermissionValidationError extends Error {
  constructor(public code: PermissionErrorCode) {
    super(code);
    this.name = "PermissionValidationError";
  }
}

export const permissionService = {
  async assignPermission(tenantId: string, input: { agentId: string; toolId: string }) {
    const [agent, tool] = await Promise.all([
      agentRepository.findById(input.agentId, tenantId),
      toolRepository.findById(input.toolId, tenantId),
    ]);

    if (!agent || !tool) {
      throw new PermissionValidationError("AGENT_OR_TOOL_NOT_FOUND");
    }

    try {
      return await permissionRepository.create({
        tenantId,
        agentId: input.agentId,
        toolId: input.toolId,
      });
    } catch (error: any) {
      if (error.code === "P2002") {
        throw new PermissionValidationError("PERMISSION_ALREADY_EXISTS");
      }
      throw error;
    }
  },

  async listPermissions(tenantId: string, agentId: string) {
    return await permissionRepository.listByAgentId(agentId, tenantId);
  },

  async revokePermission(tenantId: string, agentId: string, toolId: string) {
    const { count } = await permissionRepository.deactivate(agentId, toolId, tenantId);
    return count > 0;
  },
};