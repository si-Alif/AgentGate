import { permissionRepository } from "../repositories/permission.repository.js";

export type PermissionCheckResult =
  | { granted: true }
  | {
    granted: false;
    reason:
    | "not_found"
    | "tenant_suspended"
    | "permission_inactive"
    | "agent_inactive"
    | "tool_inactive"
    | "error";
    error?: unknown;
};


export async function checkPermission(
  tenantId: string,
  agentId: string,
  toolId: string
) : Promise<PermissionCheckResult> {
  try {
    const permission = await permissionRepository.findGrantWithContext(tenantId, agentId, toolId);

    if (!permission) {
      return { granted: false, reason: "not_found" };
    }

    if (permission.tenant.deletedAt !== null) {
      return { granted: false, reason: "tenant_suspended" };
    }

    if (!permission.isActive) return { granted: false, reason: "permission_inactive" };
    if (!permission.agent.isActive) return { granted: false, reason: "agent_inactive" };
    if (!permission.tool.isActive) return { granted: false, reason: "tool_inactive" };

    return { granted: true };
  }catch (error) {
    return { granted: false, reason: "error", error };
  }
}