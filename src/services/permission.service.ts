import { permissionRepository } from "../repositories/permission.repository.js";
import { agentRepository } from "../repositories/agent.repository.js";
import { toolRepository } from "../repositories/tool.repository.js";
import { invalidateAgentToolsListCache } from "../mcp/tools/tools-list-cache.js";

export type PermissionErrorCode = "AGENT_OR_TOOL_NOT_FOUND" | "PERMISSION_ALREADY_EXISTS";


export class PermissionValidationError extends Error {
  constructor(public code: PermissionErrorCode) {
    super(code);
    this.name = "PermissionValidationError";
  }
}

export const permissionService = {
  async assignPermission(tenantId: string, input: { agentId: string; toolId: string }) {

    // step1 : validate if the agent and tool exist in the system for the given tenantId
    const [agent, tool] = await Promise.all([
      agentRepository.findById(input.agentId, tenantId),
      toolRepository.findById(input.toolId, tenantId),
    ]);

    if (!agent || !tool) {
      throw new PermissionValidationError("AGENT_OR_TOOL_NOT_FOUND");
    }

    // if they exist :
    try {
      // create the permissions . This says this agent has permission to this tool
      const grant = await permissionRepository.create({
        tenantId,
        agentId: input.agentId,
        toolId: input.toolId,
      });

      // step3 : remove any existing chaced permission list on redis for this agent and tenantId .
      // once a new set of permission is created for an agent under a particular agent , it shouldn't have any stale permission list that might allow it to do something it's not permitted to fo
      await invalidateAgentToolsListCache(tenantId, input.agentId);

      // once done , return newly created permission grant
      return grant;
    } catch (error: any) {
      if (error.code === "P2002") {
        throw new PermissionValidationError("PERMISSION_ALREADY_EXISTS");
      }
      throw error;
    }
  },

  async listPermissions(
    tenantId: string,
    agentId: string,
    pagination?: { limit: number; offset: number }
  ) {
    const options = pagination
      ? { take: pagination.limit, skip: pagination.offset }
      : undefined;
    return await permissionRepository.listByAgentId(agentId, tenantId, options);
  },

  // removes a permission for a given agent under a tenant for a particular tool.
  async revokePermission(tenantId: string, agentId: string, toolId: string) {

    // find the permission row
    const { count } = await permissionRepository.deactivate(agentId, toolId, tenantId);

    if (count > 0) {
      // step2 : remove any existing chaced permission list on redis for this agent and tenantId .
      // once a permission is revoked for an agent under a particular agent , it shouldn't have any stale permission list that might allow it to do something it's not permitted to fo
      await invalidateAgentToolsListCache(tenantId, agentId);
    }

    return count > 0;
  },
};