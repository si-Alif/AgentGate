import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp } from "../app.js";
import { prisma } from "../lib/prisma.js";
import {
  createTestTenant,
  createTestAgent,
  createTestTool,
  cleanupTenant,
} from "./helpers/test-tenant.factory.js";

describe("Permission routes — /api/agents/:agentId/permissions (E2E)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await createApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe("POST /:agentId/permissions", () => {
    it("201s and returns the grant shape, with no tenantId leak and stub columns null", async () => {
      const tenant = await createTestTenant(app);
      const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
      const tool = await createTestTool(tenant.tenantId);

      const res = await app.inject({
        method: "POST",
        url: `/api/agents/${agent.id}/permissions`,
        headers: { Authorization: `Bearer ${tenant.accessToken}` },
        payload: { toolId: tool.id },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.agentId).toBe(agent.id);
      expect(body.toolId).toBe(tool.id);
      expect(body.isActive).toBe(true);
      expect(body.parameterConstraints).toBeNull();
      expect(body.callBudgetPerHour).toBeNull();
      expect(body).not.toHaveProperty("tenantId");

      await cleanupTenant(tenant.tenantId);
    });

    it("400s when toolId is missing from the body", async () => {
      const tenant = await createTestTenant(app);
      const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);

      const res = await app.inject({
        method: "POST",
        url: `/api/agents/${agent.id}/permissions`,
        headers: { Authorization: `Bearer ${tenant.accessToken}` },
        payload: {},
      });

      expect(res.statusCode).toBe(400);

      await cleanupTenant(tenant.tenantId);
    });

    /**
     * Depends on the global Fastify/AJV instance having
     * `removeAdditional: false` configured (per the project's own
     * noted requirement for real boundary enforcement). If this
     * fails with 201 instead of 400, check that global override
     * BEFORE assuming the route schema is wrong — Fastify's AJV
     * default silently STRIPS unknown fields rather than rejecting.
     */
    it("400s when the body includes an unexpected extra field", async () => {
      const tenant = await createTestTenant(app);
      const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
      const tool = await createTestTool(tenant.tenantId);

      const res = await app.inject({
        method: "POST",
        url: `/api/agents/${agent.id}/permissions`,
        headers: { Authorization: `Bearer ${tenant.accessToken}` },
        payload: { toolId: tool.id, callBudgetPerHour: 100 },
      });

      expect(res.statusCode).toBe(400);

      await cleanupTenant(tenant.tenantId);
    });

    it("404s when the toolId belongs to a different tenant", async () => {
      const tenantA = await createTestTenant(app);
      const tenantB = await createTestTenant(app);
      const { agent } = await createTestAgent(tenantA.tenantId, tenantA.userId);
      const foreignTool = await createTestTool(tenantB.tenantId);

      const res = await app.inject({
        method: "POST",
        url: `/api/agents/${agent.id}/permissions`,
        headers: { Authorization: `Bearer ${tenantA.accessToken}` },
        payload: { toolId: foreignTool.id },
      });

      expect(res.statusCode).toBe(404);

      await cleanupTenant(tenantA.tenantId);
      await cleanupTenant(tenantB.tenantId);
    });

    it("404s when the agentId in the URL belongs to a different tenant", async () => {
      const tenantA = await createTestTenant(app);
      const tenantB = await createTestTenant(app);
      const { agent: foreignAgent } = await createTestAgent(tenantB.tenantId, tenantB.userId);
      const tool = await createTestTool(tenantA.tenantId);

      const res = await app.inject({
        method: "POST",
        url: `/api/agents/${foreignAgent.id}/permissions`,
        headers: { Authorization: `Bearer ${tenantA.accessToken}` },
        payload: { toolId: tool.id },
      });

      expect(res.statusCode).toBe(404);

      await cleanupTenant(tenantA.tenantId);
      await cleanupTenant(tenantB.tenantId);
    });

    it("409s on a duplicate grant for the same (agent, tool) pair", async () => {
      const tenant = await createTestTenant(app);
      const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
      const tool = await createTestTool(tenant.tenantId);

      await app.inject({
        method: "POST",
        url: `/api/agents/${agent.id}/permissions`,
        headers: { Authorization: `Bearer ${tenant.accessToken}` },
        payload: { toolId: tool.id },
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/agents/${agent.id}/permissions`,
        headers: { Authorization: `Bearer ${tenant.accessToken}` },
        payload: { toolId: tool.id },
      });

      expect(res.statusCode).toBe(409);

      await cleanupTenant(tenant.tenantId);
    });

    it("401s without a token", async () => {
      const tenant = await createTestTenant(app);
      const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
      const tool = await createTestTool(tenant.tenantId);

      const res = await app.inject({
        method: "POST",
        url: `/api/agents/${agent.id}/permissions`,
        payload: { toolId: tool.id },
      });

      expect(res.statusCode).toBe(401);

      await cleanupTenant(tenant.tenantId);
    });
  });

  describe("GET /:agentId/permissions", () => {
    it("200s with the full grant list for the agent", async () => {
      const tenant = await createTestTenant(app);
      const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
      const toolX = await createTestTool(tenant.tenantId);
      const toolY = await createTestTool(tenant.tenantId);

      await app.inject({
        method: "POST",
        url: `/api/agents/${agent.id}/permissions`,
        headers: { Authorization: `Bearer ${tenant.accessToken}` },
        payload: { toolId: toolX.id },
      });
      await app.inject({
        method: "POST",
        url: `/api/agents/${agent.id}/permissions`,
        headers: { Authorization: `Bearer ${tenant.accessToken}` },
        payload: { toolId: toolY.id },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/agents/${agent.id}/permissions`,
        headers: { Authorization: `Bearer ${tenant.accessToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveLength(2);
      expect(body.every((p: any) => !("tenantId" in p))).toBe(true);

      await cleanupTenant(tenant.tenantId);
    });

    it("200s with an empty array when the agent has zero grants", async () => {
      const tenant = await createTestTenant(app);
      const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);

      const res = await app.inject({
        method: "GET",
        url: `/api/agents/${agent.id}/permissions`,
        headers: { Authorization: `Bearer ${tenant.accessToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);

      await cleanupTenant(tenant.tenantId);
    });

    it("404s for an agentId belonging to a different tenant, rather than leaking an empty list", async () => {
      const tenantA = await createTestTenant(app);
      const tenantB = await createTestTenant(app);
      const { agent: foreignAgent } = await createTestAgent(tenantB.tenantId, tenantB.userId);
      const tool = await createTestTool(tenantB.tenantId);
      await app.inject({
        method: "POST",
        url: `/api/agents/${foreignAgent.id}/permissions`,
        headers: { Authorization: `Bearer ${tenantB.accessToken}` },
        payload: { toolId: tool.id },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/agents/${foreignAgent.id}/permissions`,
        headers: { Authorization: `Bearer ${tenantA.accessToken}` },
      });

      // Must be 404, NOT 200 [] — an empty-list response here would
      // be indistinguishable from "this agent has no grants" and
      // would leak the fact that the agentId exists at all.
      expect(res.statusCode).toBe(404);

      await cleanupTenant(tenantA.tenantId);
      await cleanupTenant(tenantB.tenantId);
    });

    it("revoked grants still appear in the list (isActive:false), not hidden", async () => {
      const tenant = await createTestTenant(app);
      const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
      const tool = await createTestTool(tenant.tenantId);

      await app.inject({
        method: "POST",
        url: `/api/agents/${agent.id}/permissions`,
        headers: { Authorization: `Bearer ${tenant.accessToken}` },
        payload: { toolId: tool.id },
      });
      await app.inject({
        method: "DELETE",
        url: `/api/agents/${agent.id}/permissions/${tool.id}`,
        headers: { Authorization: `Bearer ${tenant.accessToken}` },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/agents/${agent.id}/permissions`,
        headers: { Authorization: `Bearer ${tenant.accessToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveLength(1);
      expect(body[0].isActive).toBe(false);

      await cleanupTenant(tenant.tenantId);
    });
  });

  describe("DELETE /:agentId/permissions/:toolId", () => {
    it("204s and soft-deactivates the grant in the database (not a hard delete)", async () => {
      const tenant = await createTestTenant(app);
      const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
      const tool = await createTestTool(tenant.tenantId);

      const created = await app.inject({
        method: "POST",
        url: `/api/agents/${agent.id}/permissions`,
        headers: { Authorization: `Bearer ${tenant.accessToken}` },
        payload: { toolId: tool.id },
      });
      const grantId = created.json().id;

      const res = await app.inject({
        method: "DELETE",
        url: `/api/agents/${agent.id}/permissions/${tool.id}`,
        headers: { Authorization: `Bearer ${tenant.accessToken}` },
      });

      expect(res.statusCode).toBe(204);

      const row = await prisma.agentToolPermission.findUniqueOrThrow({ where: { id: grantId } });
      // Still present — soft delete, matching the project's
      // deactivate-only convention (never a hard-delete path).
      expect(row.isActive).toBe(false);

      await cleanupTenant(tenant.tenantId);
    });

    it("404s for a grant that was never created", async () => {
      const tenant = await createTestTenant(app);
      const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
      const tool = await createTestTool(tenant.tenantId);

      const res = await app.inject({
        method: "DELETE",
        url: `/api/agents/${agent.id}/permissions/${tool.id}`,
        headers: { Authorization: `Bearer ${tenant.accessToken}` },
      });

      expect(res.statusCode).toBe(404);

      await cleanupTenant(tenant.tenantId);
    });

    it("404s when attempting to revoke another tenant's real grant by guessing its IDs", async () => {
      const tenantA = await createTestTenant(app);
      const tenantB = await createTestTenant(app);
      const { agent } = await createTestAgent(tenantB.tenantId, tenantB.userId);
      const tool = await createTestTool(tenantB.tenantId);
      const created = await app.inject({
        method: "POST",
        url: `/api/agents/${agent.id}/permissions`,
        headers: { Authorization: `Bearer ${tenantB.accessToken}` },
        payload: { toolId: tool.id },
      });
      const grantId = created.json().id;

      const res = await app.inject({
        method: "DELETE",
        url: `/api/agents/${agent.id}/permissions/${tool.id}`,
        headers: { Authorization: `Bearer ${tenantA.accessToken}` }, // wrong tenant's token
      });

      expect(res.statusCode).toBe(404);

      const untouched = await prisma.agentToolPermission.findUniqueOrThrow({ where: { id: grantId } });
      expect(untouched.isActive).toBe(true);

      await cleanupTenant(tenantA.tenantId);
      await cleanupTenant(tenantB.tenantId);
    });
  });
});