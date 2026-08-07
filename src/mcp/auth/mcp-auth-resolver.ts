import { parseApiKey, verifyApiKeySecret } from "../../lib/api-key.js";
import { agentRepository } from "../../repositories/agent.repository.js";
import { getCachedIdentity, setCachedIdentity } from "./mcp-auth-cache.js";
import type { CachedIdentity } from "./mcp-auth-cache.js";

export interface ResolvedIdentity {
  agentId: string;
  tenantId: string;
}

export type IdentityResolutionResult =
  | { ok: true; identity: ResolvedIdentity; source: "cache" | "database" }
  | {
    ok: false;
    reason: "malformed_credential" | "not_found" | "agent_inactive" | "tenant_suspended" | "infra_unavailable";
  };

function isGranted(cached: Pick<CachedIdentity, "agentActive" | "tenantActive">): boolean {
  return cached.agentActive && cached.tenantActive;
}

/**
 * Denial reasons check TENANT scope first, matching Week 3's
 * checkPermission() precedent exactly: a suspended tenant invalidates
 * every agent underneath it, so that's reported regardless of the
 * agent's own isActive flag.
 */
function denialReason(agentActive: boolean, tenantActive: boolean): "agent_inactive" | "tenant_suspended" {
  return tenantActive ? "agent_inactive" : "tenant_suspended";
}

export async function resolveAgentIdentity(
  authorizationHeader: string | undefined
): Promise<IdentityResolutionResult> {
  if (!authorizationHeader?.startsWith("Bearer ")) {
    return { ok: false, reason: "malformed_credential" };
  }

  const rawApiKey = authorizationHeader.slice("Bearer ".length).trim();
  const parsed = parseApiKey(rawApiKey);
  if (!parsed) {
    return { ok: false, reason: "malformed_credential" };
  }

  const cached = await getCachedIdentity(rawApiKey);
  if (cached) {
    if (!isGranted(cached)) {
      return { ok: false, reason: denialReason(cached.agentActive, cached.tenantActive) };
    }
    return {
      ok: true,
      identity: { agentId: cached.agentId, tenantId: cached.tenantId },
      source: "cache",
    };
  }

  // Cache miss — full verification path (Postgres + Argon2).
  let row: Awaited<ReturnType<typeof agentRepository.findByKeyIdWithTenantContext>>;
  try {
    row = await agentRepository.findByKeyIdWithTenantContext(parsed.keyId);
  }catch(err){
    console.error("[mcp-auth-resolver] identity lookup failed (infra fault):", err);
    return { ok: false, reason: "infra_unavailable" };
  }

  if (!row) {
    return { ok: false, reason: "not_found" };
  }

  const secretValid = await verifyApiKeySecret(row.apiKeyHash, parsed.secret);
  if (!secretValid) {
    //  A wrong secret against a real keyId pays the full Argon2 cost on every retry, bounded by the coarse message-rate pre-check , not by this function.
    return { ok: false, reason: "not_found" };
  }

  const agentActive = row.isActive;
  const tenantActive = row.tenant.deletedAt === null;

  // Cache the VERIFIED identity regardless of active-flag outcome —
  // see the concept primer in mcp-auth-cache.ts.
  await setCachedIdentity(rawApiKey, {
    agentId: row.id,
    tenantId: row.tenantId,
    agentActive,
    tenantActive,
    cachedAt: Date.now(),
  });

  if (!agentActive || !tenantActive) {
    return { ok: false, reason: denialReason(agentActive, tenantActive) };
  }

  return {
    ok: true,
    identity: { agentId: row.id, tenantId: row.tenantId },
    source: "database",
  };
}