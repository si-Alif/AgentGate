import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp } from "../app.js";
import { prisma } from "../lib/prisma.js";
import { permissionService, PermissionValidationError } from "../services/permission.service.js";
import {
  createTestTenant,
  createTestAgent,
  createTestTool,
  cleanupTenant,
} from "./helpers/test-tenant.factory.js";

describe("permissionService", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await createApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe("assignPermission", () => {
    it("creates a grant when agent and tool both belong to the tenant", async () => {
      const tenant = await createTestTenant(app);
      const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
      const tool = await createTestTool(tenant.tenantId);

      const grant = await permissionService.assignPermission(tenant.tenantId, {
        agentId: agent.id,
        toolId: tool.id,
      });

      expect(grant.isActive).toBe(true);
      expect(grant.agentId).toBe(agent.id);
      expect(grant.toolId).toBe(tool.id);

      await cleanupTenant(tenant.tenantId);
    });

    it("rejects assigning a foreign tenant's TOOL to your own agent", async () => {
      const tenantA = await createTestTenant(app);
      const tenantB = await createTestTenant(app);
      const { agent } = await createTestAgent(tenantA.tenantId, tenantA.userId);
      const foreignTool = await createTestTool(tenantB.tenantId);

      await expect(
        permissionService.assignPermission(tenantA.tenantId, { agentId: agent.id, toolId: foreignTool.id })
      ).rejects.toMatchObject({ code: "AGENT_OR_TOOL_NOT_FOUND" });

      await cleanupTenant(tenantA.tenantId);
      await cleanupTenant(tenantB.tenantId);
    });

    it("rejects assigning a foreign tenant's AGENT alongside your own tool", async () => {
      const tenantA = await createTestTenant(app);
      const tenantB = await createTestTenant(app);
      const { agent: foreignAgent } = await createTestAgent(tenantB.tenantId, tenantB.userId);
      const tool = await createTestTool(tenantA.tenantId);

      await expect(
        permissionService.assignPermission(tenantA.tenantId, { agentId: foreignAgent.id, toolId: tool.id })
      ).rejects.toMatchObject({ code: "AGENT_OR_TOOL_NOT_FOUND" });

      await cleanupTenant(tenantA.tenantId);
      await cleanupTenant(tenantB.tenantId);
    });

    it("rejects when the agentId doesn't exist at all (not just wrong-tenant)", async () => {
      const tenant = await createTestTenant(app);
      const tool = await createTestTool(tenant.tenantId);

      await expect(
        permissionService.assignPermission(tenant.tenantId, {
          agentId: "00000000-0000-0000-0000-000000000000",
          toolId: tool.id,
        })
      ).rejects.toMatchObject({ code: "AGENT_OR_TOOL_NOT_FOUND" });

      await cleanupTenant(tenant.tenantId);
    });

    it("rejects when the toolId doesn't exist at all", async () => {
      const tenant = await createTestTenant(app);
      const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);

      await expect(
        permissionService.assignPermission(tenant.tenantId, {
          agentId: agent.id,
          toolId: "00000000-0000-0000-0000-000000000000",
        })
      ).rejects.toMatchObject({ code: "AGENT_OR_TOOL_NOT_FOUND" });

      await cleanupTenant(tenant.tenantId);
    });

    it("rejects a duplicate grant for the same (agent, tool) pair", async () => {
      const tenant = await createTestTenant(app);
      const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
      const tool = await createTestTool(tenant.tenantId);

      await permissionService.assignPermission(tenant.tenantId, { agentId: agent.id, toolId: tool.id });

      await expect(
        permissionService.assignPermission(tenant.tenantId, { agentId: agent.id, toolId: tool.id })
      ).rejects.toThrow("PERMISSION_ALREADY_EXISTS");

      await cleanupTenant(tenant.tenantId);
    });

    /**
     * ⚠️ KNOWN GAP — documented, not fixed here.
     *
     * @@unique([agentId, toolId]) applies regardless of isActive.
     * revokePermission() only flips isActive=false; it never deletes
     * the row. assignPermission()'s create() is a bare INSERT, so
     * re-granting a previously revoked pair collides with the
     * still-present inactive row and surfaces as P2002 — mapped to
     * "PERMISSION_ALREADY_EXISTS", which is misleading: from the
     * caller's perspective there is currently NO active grant.
     *
     * This test locks in CURRENT behavior so a future change here is
     * a deliberate decision, not an accidental regression. Likely
     * correct fix when you choose to make it: assignPermission()
     * should find-then-upsert — if an inactive row exists for
     * (agentId, toolId), reactivate it instead of inserting.
     */
    it("re-assigning a previously revoked pair currently throws PERMISSION_ALREADY_EXISTS — documents a gap, not desired behavior", async () => {
      const tenant = await createTestTenant(app);
      const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
      const tool = await createTestTool(tenant.tenantId);

      await permissionService.assignPermission(tenant.tenantId, { agentId: agent.id, toolId: tool.id });
      await permissionService.revokePermission(tenant.tenantId, agent.id, tool.id);

      await expect(
        permissionService.assignPermission(tenant.tenantId, { agentId: agent.id, toolId: tool.id })
      ).rejects.toThrow("PERMISSION_ALREADY_EXISTS");

      await cleanupTenant(tenant.tenantId);
    });
  });

  describe("listPermissions", () => {
    it("returns grants scoped to exactly one agent within one tenant", async () => {
      const tenant = await createTestTenant(app);
      const { agent: agentA } = await createTestAgent(tenant.tenantId, tenant.userId);
      const { agent: agentB } = await createTestAgent(tenant.tenantId, tenant.userId);
      const toolX = await createTestTool(tenant.tenantId);
      const toolY = await createTestTool(tenant.tenantId);

      await permissionService.assignPermission(tenant.tenantId, { agentId: agentA.id, toolId: toolX.id });
      await permissionService.assignPermission(tenant.tenantId, { agentId: agentA.id, toolId: toolY.id });
      await permissionService.assignPermission(tenant.tenantId, { agentId: agentB.id, toolId: toolX.id });

      const listA = await permissionService.listPermissions(tenant.tenantId, agentA.id);
      expect(listA).toHaveLength(2);
      expect(listA.every((p) => p.agentId === agentA.id)).toBe(true);

      const listB = await permissionService.listPermissions(tenant.tenantId, agentB.id);
      expect(listB).toHaveLength(1);

      await cleanupTenant(tenant.tenantId);
    });

    it("returns an empty array for an agent with zero grants", async () => {
      const tenant = await createTestTenant(app);
      const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);

      const list = await permissionService.listPermissions(tenant.tenantId, agent.id);
      expect(list).toEqual([]);

      await cleanupTenant(tenant.tenantId);
    });

    /**
     * listByAgent() has no isActive filter in its WHERE clause —
     * revoked grants remain visible, just flagged inactive. Probably
     * intentional (audit-friendly history), but worth a named,
     * explicit test rather than an implicit assumption a future
     * reader might get wrong.
     */
    it("does NOT hide a revoked grant — it still appears in the list with isActive:false", async () => {
      const tenant = await createTestTenant(app);
      const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
      const tool = await createTestTool(tenant.tenantId);
      await permissionService.assignPermission(tenant.tenantId, { agentId: agent.id, toolId: tool.id });
      await permissionService.revokePermission(tenant.tenantId, agent.id, tool.id);

      const list = await permissionService.listPermissions(tenant.tenantId, agent.id) as Array<{ isActive: boolean }>;
      expect(list).toHaveLength(1);
      expect(list[0]?.isActive).toBe(false);

      await cleanupTenant(tenant.tenantId);
    });
  });

  describe("revokePermission", () => {
    it("soft-deactivates the grant — the row still exists, isActive becomes false", async () => {
      const tenant = await createTestTenant(app);
      const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
      const tool = await createTestTool(tenant.tenantId);
      const grant = await permissionService.assignPermission(tenant.tenantId, { agentId: agent.id, toolId: tool.id });

      const revoked = await permissionService.revokePermission(tenant.tenantId, agent.id, tool.id);
      expect(revoked).toBe(true);

      const row = await prisma.agentToolPermission.findUniqueOrThrow({ where: { id: grant.id } });
      expect(row.isActive).toBe(false);

      await cleanupTenant(tenant.tenantId);
    });

    it("returns false for a grant that never existed", async () => {
      const tenant = await createTestTenant(app);
      const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
      const tool = await createTestTool(tenant.tenantId);

      const revoked = await permissionService.revokePermission(tenant.tenantId, agent.id, tool.id);
      expect(revoked).toBe(false);

      await cleanupTenant(tenant.tenantId);
    });

    it("returns false for a cross-tenant attempt, and does not touch the real grant", async () => {
      const tenantA = await createTestTenant(app);
      const tenantB = await createTestTenant(app);
      const { agent } = await createTestAgent(tenantB.tenantId, tenantB.userId);
      const tool = await createTestTool(tenantB.tenantId);
      const grant = await permissionService.assignPermission(tenantB.tenantId, { agentId: agent.id, toolId: tool.id });

      // Tenant A attempts to revoke Tenant B's grant using Tenant
      // B's real IDs — the tenantId in the WHERE clause is what must
      // stop this, not obscurity of the IDs involved.
      const revoked = await permissionService.revokePermission(tenantA.tenantId, agent.id, tool.id);
      expect(revoked).toBe(false);

      const untouched = await prisma.agentToolPermission.findUniqueOrThrow({ where: { id: grant.id } });
      expect(untouched.isActive).toBe(true);

      await cleanupTenant(tenantA.tenantId);
      await cleanupTenant(tenantB.tenantId);
    });

    it("is idempotent — revoking an already-revoked grant still returns true", async () => {
      const tenant = await createTestTenant(app);
      const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
      const tool = await createTestTool(tenant.tenantId);
      await permissionService.assignPermission(tenant.tenantId, { agentId: agent.id, toolId: tool.id });

      const first = await permissionService.revokePermission(tenant.tenantId, agent.id, tool.id);
      const second = await permissionService.revokePermission(tenant.tenantId, agent.id, tool.id);

      expect(first).toBe(true);
      // deactivate()'s WHERE clause doesn't filter on current
      // isActive state, so the row still matches on the second call.
      expect(second).toBe(true);

      await cleanupTenant(tenant.tenantId);
    });
  });
});