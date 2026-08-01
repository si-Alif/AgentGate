import { permissionRepository } from "../../repositories/permission.repository.js";
import { getCachedToolsList, setCachedToolsList } from "./tools-list-cache.js";
import { toToolDescriptor, type ToolDescriptor } from "./tool-descriptor.js";
import { McpGatewayError } from "../errors/mcp-error-taxonomy.js";
import type { ResolvedIdentity } from "../auth/mcp-auth-resolver.js";

export interface ToolsListResult {
  tools: ToolDescriptor[];
  ttlMs: number;
  cacheScope: "agent";
}

/**
 * The orchestrator: cache-aside over the read-optimized repository
 * query. A cache HIT never touches Postgres. A cache MISS runs the
 * fresh, correctly-scoped query and populates the cache for next time.
 *
 * A genuine repository failure is NOT swallowed into an empty list —
 * that would silently misinform an agent that it has zero permitted
 * tools, rather than correctly telling it the gateway is degraded
 * right now. It's thrown as a McpGatewayError (-32002 SERVICE_DEGRADED)
 * relying on the setErrorHandler fix to actually ,
 * preserve that code instead of collapsing to a generic -32603.
 */
export async function handleToolsList(identity: ResolvedIdentity): Promise<ToolsListResult> {
  const cached = await getCachedToolsList(identity.tenantId, identity.agentId);
  if (cached) {
    return { tools: cached.tools, ttlMs: cached.remainingTtlMs, cacheScope: "agent" };
  }


  let grants: Awaited<ReturnType<typeof permissionRepository.listActiveGrantsForAgent>>;
  try {
    grants = await permissionRepository.listActiveGrantsForAgent(identity.agentId, identity.tenantId);
  } catch (err) {
    console.error("[tools-list-handler] listActiveGrantsForAgent failed:", err);
    throw McpGatewayError.fromSignal("SERVICE_DEGRADED", { reason: "tools_list_query_failed" });
  }

  const tools = grants.map((g) => toToolDescriptor(g.tool));
  const ttlMs = await setCachedToolsList(identity.tenantId, identity.agentId, tools);

  return { tools, ttlMs, cacheScope: "agent" };
}