import { describe, it, expect , vi } from "vitest";
import crypto from "node:crypto";
import {
  getCachedToolsList,
  setCachedToolsList,
  invalidateAgentToolsListCache,
  invalidateTenantToolsListCache,
} from "../mcp/tools/tools-list-cache.js";
import { rateLimiterRedis } from "../lib/rate-limiter.js";
import type { ToolDescriptor } from "../mcp/tools/tool-descriptor.js";

const sampleTools: ToolDescriptor[] = [{ name: "sample-tool", description: "d", inputSchema: {} }];

describe("tools-list-cache — real Redis round-trip", () => {
  it("round-trips a cached tools list", async () => {
    const tenantId = crypto.randomUUID();
    const agentId = crypto.randomUUID();
    await setCachedToolsList(tenantId, agentId, sampleTools);
    const hit = await getCachedToolsList(tenantId, agentId);
    expect(hit?.tools).toEqual(sampleTools);
  });

  it("returns null for a never-cached agent", async () => {
    expect(await getCachedToolsList(crypto.randomUUID(), crypto.randomUUID())).toBeNull();
  });

  it("Decision 3.3 — a fresh write's ttlMs equals the full configured window", async () => {
    const ttlMs = await setCachedToolsList(crypto.randomUUID(), crypto.randomUUID(), sampleTools);
    expect(ttlMs).toBe(30_000); // AGENTGATE_MCP_TOOLS_LIST_CACHE_TTL_SECONDS default
  });

  it("Decision 3.3 — a hit's ttlMs is the REMAINING window, strictly less than the full configured one", async () => {
    const tenantId = crypto.randomUUID();
    const agentId = crypto.randomUUID();
    await setCachedToolsList(tenantId, agentId, sampleTools);

    await new Promise((r) => setTimeout(r, 300));

    const hit = await getCachedToolsList(tenantId, agentId);
    expect(hit).not.toBeNull();
    expect(hit!.remainingTtlMs).toBeLessThan(30_000);
    expect(hit!.remainingTtlMs).toBeGreaterThan(0);
  });

  it("GATE — invalidateAgentToolsListCache removes only the ONE targeted agent's entry", async () => {
    const tenantId = crypto.randomUUID();
    const agentA = crypto.randomUUID();
    const agentB = crypto.randomUUID();
    await setCachedToolsList(tenantId, agentA, sampleTools);
    await setCachedToolsList(tenantId, agentB, sampleTools);

    await invalidateAgentToolsListCache(tenantId, agentA);

    expect(await getCachedToolsList(tenantId, agentA)).toBeNull();
    expect(await getCachedToolsList(tenantId, agentB)).not.toBeNull();
  });

  it("GATE — invalidateTenantToolsListCache removes EVERY cached agent for that tenant, using ONLY tenantId (never a raw agent list passed in)", async () => {
    const tenantId = crypto.randomUUID();
    const agentIds = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    for (const agentId of agentIds) {
      await setCachedToolsList(tenantId, agentId, sampleTools);
    }

    // The caller here has ONLY tenantId — exactly what
    // toolService.deactivateTool() has available. This is the literal
    // proof of the F2 fix (Decision 3.1).
    await invalidateTenantToolsListCache(tenantId);

    for (const agentId of agentIds) {
      expect(await getCachedToolsList(tenantId, agentId)).toBeNull();
    }
  });

  it("broadcast invalidation never touches a DIFFERENT tenant's cached entries", async () => {
    const tenantA = crypto.randomUUID();
    const tenantB = crypto.randomUUID();
    const agentInB = crypto.randomUUID();
    await setCachedToolsList(tenantB, agentInB, sampleTools);

    await invalidateTenantToolsListCache(tenantA);

    expect(await getCachedToolsList(tenantB, agentInB)).not.toBeNull();
  });

  it("broadcast invalidation is a no-op (not an error) when nothing was ever cached for that tenant", async () => {
    await expect(invalidateTenantToolsListCache(crypto.randomUUID())).resolves.toBeUndefined();
  });

  it("a Redis GET failure degrades to a cache miss, never throws", async () => {
    const spy = vi.spyOn(rateLimiterRedis, "get").mockRejectedValue(new Error("ECONNRESET"));
    await expect(getCachedToolsList(crypto.randomUUID(), crypto.randomUUID())).resolves.toBeNull();
    spy.mockRestore();
  });

  it("a Redis SET failure never propagates to the caller", async () => {
    const spy = vi.spyOn(rateLimiterRedis, "pipeline").mockImplementation(() => {
      throw new Error("simulated pipeline failure");
    });
    await expect(setCachedToolsList(crypto.randomUUID(), crypto.randomUUID(), sampleTools)).resolves.toBe(30_000);
    spy.mockRestore();
  });
});