import crypto from "node:crypto";
import { rateLimiterRedis } from "../../lib/rate-limiter.js";
import { env } from "../../config/env.js";

const CREDENTIAL_KEY_PREFIX = "mcp:auth";
const REVERSE_INDEX_PREFIX = "mcp:auth:byAgent";

export interface CachedIdentity {
  agentId: string;
  tenantId: string;
  agentActive: boolean;
  tenantActive: boolean;
  cachedAt: number; // epoch ms — informational only, not used for TTL (Redis EX owns that)
}

function credentialCacheKey(rawApiKey: string): string {
  const digest = crypto.createHash("sha256").update(rawApiKey).digest("hex");
  return `${CREDENTIAL_KEY_PREFIX}:${digest}`;
}

function reverseIndexKey(agentId: string): string {
  return `${REVERSE_INDEX_PREFIX}:${agentId}`;
}


export async function getCachedIdentity(rawApiKey: string): Promise<CachedIdentity | null> {
  try {
    const raw = await rateLimiterRedis.get(credentialCacheKey(rawApiKey));
    if (!raw) return null;
    return JSON.parse(raw) as CachedIdentity;
  } catch (err) {
    console.warn("[mcp-auth-cache] GET failed — falling through to full verification:", err);
    return null;
  }
}


export async function setCachedIdentity(rawApiKey: string, identity: CachedIdentity): Promise<void> {
  const ttl = env.AGENTGATE_MCP_AUTH_CACHE_TTL_SECONDS;
  const credKey = credentialCacheKey(rawApiKey);
  const indexKey = reverseIndexKey(identity.agentId);

  try {
    await rateLimiterRedis
      .pipeline()
      .set(credKey, JSON.stringify(identity), "EX", ttl)
      .sadd(indexKey, credKey)
      .expire(indexKey, ttl)
      .exec();
  } catch (err) {
    // Never let a caching failure block a successful auth resolution —
    // the CALLER's request still succeeded via full verification; only
    // the next request pays the slow-path cost again.
    console.warn("[mcp-auth-cache] SET failed — this identity will not be cached:", err);
  }
}


export async function invalidateAgentCache(agentId: string): Promise<void> {
  const indexKey = reverseIndexKey(agentId);
  try {
    const cachedKeys = await rateLimiterRedis.smembers(indexKey);
    if (cachedKeys.length > 0) {
      await rateLimiterRedis.del(...cachedKeys, indexKey);
    } else {
      await rateLimiterRedis.del(indexKey);
    }
  } catch (err) {
    console.warn(
      `[mcp-auth-cache] invalidation failed for agent ${agentId} — stale entries may persist up to TTL:`,
      err
    );
  }
}