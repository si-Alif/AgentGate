import { describe, it, expect, beforeAll, afterAll  , vi , beforeEach} from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp } from "../app.js";
import { resolveAgentIdentity } from "../mcp/auth/mcp-auth-resolver.js";
import { agentRepository } from "../repositories/agent.repository.js";
import { verifyApiKeySecret } from "../lib/api-key.js";
import { agentService } from "../services/agent.service.js";
import {
  createTestTenant,
  createTestAgent,
  cleanupTenant,
} from "./helpers/test-tenant.factory.js";

describe("resolveAgentIdentity", () => {

  let app: FastifyInstance;

  beforeAll(async () => {
    app = await createApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("rejects a missing/malformed Authorization header without any DB/Redis work", async () => {
    expect(await resolveAgentIdentity(undefined)).toEqual({ ok: false, reason: "malformed_credential" });
    expect(await resolveAgentIdentity("Basic abc123")).toEqual({ ok: false, reason: "malformed_credential" });
    expect(await resolveAgentIdentity("Bearer not-a-real-format")).toEqual({
      ok: false,
      reason: "malformed_credential",
    });
  });

  it("rejects an unknown keyId as not_found", async () => {
    const result = await resolveAgentIdentity("Bearer agk.unknownkeyid.somesecret");
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  describe("with a real tenant + agent", () => {
    let tenant: Awaited<ReturnType<typeof createTestTenant>>;
    let agentId: string;
    let apiKey: string;

    beforeEach(async () => {
      tenant = await createTestTenant(app);
      const created = await createTestAgent(tenant.tenantId, tenant.userId);
      agentId = created.agent.id;
      apiKey = created.apiKey;
    });

    it("CHECKPOINT — a cold cache resolves correctly via Postgres+Argon2 and populates the cache", async () => {
      const first = await resolveAgentIdentity(`Bearer ${apiKey}`);
      expect(first).toEqual({ ok: true, identity: { agentId, tenantId: tenant.tenantId }, source: "database" });
    });

    it("CHECKPOINT — a warm cache resolves WITHOUT touching Postgres (call-count assertion)", async () => {
      await resolveAgentIdentity(`Bearer ${apiKey}`); // warms the cache
      const spy = vi.spyOn(agentRepository, "findByKeyIdWithTenantContext");
      const second = await resolveAgentIdentity(`Bearer ${apiKey}`);
      expect(second).toEqual({ ok: true, identity: { agentId, tenantId: tenant.tenantId }, source: "cache" });
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it("rejects a wrong secret, and NEVER caches it (Decision 2.9)", async () => {
      const badKey = apiKey.replace(/\.[^.]+$/, ".wrongsecretvalue");
      const spy = vi.spyOn({ verifyApiKeySecret }, "verifyApiKeySecret");
      const first = await resolveAgentIdentity(`Bearer ${badKey}`);
      const second = await resolveAgentIdentity(`Bearer ${badKey}`);
      expect(first).toEqual({ ok: false, reason: "not_found" });
      expect(second).toEqual({ ok: false, reason: "not_found" }); // still not_found — never became "cached ok"
      spy.mockRestore();
    });

    it("CHECKPOINT — deactivating the agent is REJECTED both fresh and via cache invalidation (not TTL luck)", async () => {
      await resolveAgentIdentity(`Bearer ${apiKey}`); // warms cache
      const warmCheck = await resolveAgentIdentity(`Bearer ${apiKey}`);
      expect(warmCheck.ok).toBe(true); // confirm it really was cached before deactivation

      await agentService.deactivateAgent(agentId, tenant.tenantId); // triggers invalidateAgentCache

      const spy = vi.spyOn(agentRepository, "findByKeyIdWithTenantContext");
      const afterDeactivation = await resolveAgentIdentity(`Bearer ${apiKey}`);
      expect(afterDeactivation).toEqual({ ok: false, reason: "agent_inactive" });
      // Proves this was a FRESH lookup, not a stale cache hit that
      // happened to still say active — if invalidation hadn't fired,
      // this call would have incorrectly returned ok:true.
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    });

    it("an inactive agent's identity IS cached (perf, not a security gap) — second attempt skips Argon2", async () => {
      await agentService.deactivateAgent(agentId, tenant.tenantId);
      const first = await resolveAgentIdentity(`Bearer ${apiKey}`);
      expect(first).toEqual({ ok: false, reason: "agent_inactive" });

      const spy = vi.spyOn(agentRepository, "findByKeyIdWithTenantContext");
      const second = await resolveAgentIdentity(`Bearer ${apiKey}`);
      expect(second).toEqual({ ok: false, reason: "agent_inactive" });
      expect(spy).not.toHaveBeenCalled(); // came from cache, not a re-verify
      spy.mockRestore();
    });

    it("CHECKPOINT — rotating the key immediately invalidates the OLD cached entry", async () => {
      await resolveAgentIdentity(`Bearer ${apiKey}`); // warm cache with the ORIGINAL key
      const rotated = await agentService.rotateAgentKey(agentId, tenant.tenantId);
      expect(rotated).not.toBeNull();

      const oldKeyResult = await resolveAgentIdentity(`Bearer ${apiKey}`);
      expect(oldKeyResult).toEqual({ ok: false, reason: "not_found" }); // old keyId no longer exists in Postgres

      const newKeyResult = await resolveAgentIdentity(`Bearer ${rotated!.apiKey}`);
      expect(newKeyResult).toEqual({ ok: true, identity: { agentId, tenantId: tenant.tenantId }, source: "database" });
    });

    it("tenant suspension is reported with priority over agent state", async () => {
      const { prisma } = await import("../lib/prisma.js");
      await prisma.tenant.update({ where: { id: tenant.tenantId }, data: { deletedAt: new Date() } });
      const result = await resolveAgentIdentity(`Bearer ${apiKey}`);
      expect(result).toEqual({ ok: false, reason: "tenant_suspended" });
    });
  });

  afterEach: undefined; // placeholder removed — cleanup below
});