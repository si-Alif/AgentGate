import { rateLimiterRedis } from "../../lib/rate-limiter.js";
import { env } from "../../config/env.js";
import type { ToolDescriptor } from "./tool-descriptor.js";

const CACHE_KEY_PREFIX = "mcp:toolslist";
const TENANT_INDEX_PREFIX = "mcp:toolslist:byTenant";

interface CachedToolsListEntry {
  tools: ToolDescriptor[];
  cachedAt: number; // informational only — NOT used to compute ttlMs; see getCachedToolsList
}

export interface ToolsListCacheHit {
  tools: ToolDescriptor[];
  remainingTtlMs: number;
}

function toolsListCacheKey(tenantId: string, agentId: string): string {
  // Includes BOTH ids even though agentId alone is already
  // tenant-unique cz never trusting a shared/unique key alone across a
  // tenant boundary.
  return `${CACHE_KEY_PREFIX}:${tenantId}:${agentId}`;
}

function tenantReverseIndexKey(tenantId: string): string {
  return `${TENANT_INDEX_PREFIX}:${tenantId}`;
}


export async function getCachedToolsList(
  tenantId: string,
  agentId: string
): Promise<ToolsListCacheHit | null> {
  const key = toolsListCacheKey(tenantId, agentId);
  try {
    const [raw, pttl] = await Promise.all([
      rateLimiterRedis.get(key),
      rateLimiterRedis.pttl(key),
    ]);
    if (!raw || pttl <= 0) return null;
    const entry = JSON.parse(raw) as CachedToolsListEntry;
    return { tools: entry.tools, remainingTtlMs: pttl };
  } catch (err) {
    console.warn("[tools-list-cache] GET failed — falling through to a fresh query:", err);
    return null;
  }
}

/**
 * Populates BOTH the primary entry and the tenant reverse index in one
 * pipeline — the index is what makes broadcast invalidation (tool
 * deactivation) possible without an extra query at invalidation time.
 * Direct structural mirror of mcp-auth-cache.ts's setCachedIdentity();.
 *
 * Returns the ttlMs to report to the CALLER of this fresh write — the
 * full configured window, which is accurate at this exact instant
 * regardless of whether the SET itself below succeeds. If the SET
 * fails (caught, logged), the next call is simply a fresh miss again;
 * nothing is ever served stale because of a failed write.
 */
export async function setCachedToolsList(
  tenantId: string,
  agentId: string,
  tools: ToolDescriptor[]
): Promise<number> {
  const ttlSeconds = env.AGENTGATE_MCP_TOOLS_LIST_CACHE_TTL_SECONDS;
  const key = toolsListCacheKey(tenantId, agentId);
  const indexKey = tenantReverseIndexKey(tenantId);
  const entry: CachedToolsListEntry = { tools, cachedAt: Date.now() };

  try {
    await rateLimiterRedis
      .pipeline()
      .set(key, JSON.stringify(entry), "EX", ttlSeconds)
      .sadd(indexKey, agentId)
      .expire(indexKey, ttlSeconds)
      .exec();
  } catch (err) {
    console.warn("[tools-list-cache] SET failed — this result will not be cached:", err);
  }

  return ttlSeconds * 1000;
}

/**
 * DIRECT invalidation — used by permissionService.assignPermission /
 * revokePermission, where agentId is already known at the call site.
 */
export async function invalidateAgentToolsListCache(tenantId: string, agentId: string): Promise<void> {
  try {
    await rateLimiterRedis.del(toolsListCacheKey(tenantId, agentId));
  } catch (err) {
    console.warn(
      `[tools-list-cache] direct invalidation failed for agent ${agentId} — stale entry may persist up to TTL:`,
      err
    );
  }
}

/**
 * BROADCAST invalidation — used by toolService.deactivateTool, which
 * knows only toolId+tenantId, never which agents held a grant to it.
 * Consults the reverse index populated in setCachedToolsList() to find
 * every agent whose cache needs clearing, WITHOUT a permission-join
 * query. Direct structural mirror of mcp-auth-cache.ts's
 * invalidateAgentCache().
 *
 * Best-effort: if this fails, affected entries survive until their own
 * TTL — an accepted, bounded staleness window, same class of tradeoff
 * as the direct path and as Day 2's auth-cache invalidation.
 */
export async function invalidateTenantToolsListCache(tenantId: string): Promise<void> {
  const indexKey = tenantReverseIndexKey(tenantId);
  try {
    const agentIds = await rateLimiterRedis.smembers(indexKey);
    if (agentIds.length > 0) {
      const keys = agentIds.map((agentId) => toolsListCacheKey(tenantId, agentId));
      await rateLimiterRedis.del(...keys, indexKey);
    } else {
      await rateLimiterRedis.del(indexKey);
    }
  } catch (err) {
    console.warn(
      `[tools-list-cache] broadcast invalidation failed for tenant ${tenantId} — stale entries may persist up to TTL:`,
      err
    );
  }
}