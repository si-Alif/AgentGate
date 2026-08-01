import { describe, it, expect, vi } from "vitest";
import crypto from "node:crypto";
import { rateLimiterRedis } from "../lib/rate-limiter.js";
import { getCachedIdentity, setCachedIdentity, invalidateAgentCache } from "../mcp/auth/mcp-auth-cache.js";

function makeIdentity(overrides: Partial<Parameters<typeof setCachedIdentity>[1]> = {}) {
  return {
    agentId: crypto.randomUUID(),
    tenantId: crypto.randomUUID(),
    agentActive: true,
    tenantActive: true,
    cachedAt: Date.now(),
    ...overrides,
  };
}

describe("mcp-auth-cache — real Redis round-trip", () => {
  it("round-trips a cached identity", async () => {
    const rawKey = `agk.${crypto.randomUUID()}.${crypto.randomUUID()}`;
    const identity = makeIdentity();
    await setCachedIdentity(rawKey, identity);
    const cached = await getCachedIdentity(rawKey);
    expect(cached).toMatchObject({ agentId: identity.agentId, tenantId: identity.tenantId });
  });

  it("returns null for a never-cached key", async () => {
    expect(await getCachedIdentity(`agk.${crypto.randomUUID()}.never-cached`)).toBeNull();
  });

  it("GATE — invalidateAgentCache removes the entry via the reverse index, WITHOUT knowing the raw key", async () => {
    const rawKey = `agk.${crypto.randomUUID()}.${crypto.randomUUID()}`;
    const identity = makeIdentity();
    await setCachedIdentity(rawKey, identity);
    expect(await getCachedIdentity(rawKey)).not.toBeNull();

    // The caller here has ONLY agentId — exactly what
    // rotateApiKey()/deactivateAgent() have available. It does NOT
    // have rawKey. This is the literal proof of the F1 fix.
    await invalidateAgentCache(identity.agentId);

    expect(await getCachedIdentity(rawKey)).toBeNull();
  });

  it("invalidation is a no-op (not an error) when nothing was ever cached for that agent", async () => {
    await expect(invalidateAgentCache(crypto.randomUUID())).resolves.toBeUndefined();
  });

  it("a Redis GET failure degrades to a cache miss, never throws", async () => {
    const spy = vi.spyOn(rateLimiterRedis, "get").mockRejectedValue(new Error("ECONNRESET"));
    await expect(getCachedIdentity("anything")).resolves.toBeNull();
    spy.mockRestore();
  });

  it("a Redis SET failure never propagates to the caller", async () => {
    const spy = vi.spyOn(rateLimiterRedis, "pipeline").mockImplementation(() => {
      throw new Error("simulated pipeline failure");
    });
    await expect(setCachedIdentity("anything", makeIdentity())).resolves.toBeUndefined();
    spy.mockRestore();
  });
});