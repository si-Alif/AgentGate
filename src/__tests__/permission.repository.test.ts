import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp } from "../app.js";
import { permissionRepository } from "../repositories/permission.repository.js";
import {
  createTestTenant,
  createTestAgent,
  createTestTool,
  cleanupTenant,
} from "./helpers/test-tenant.factory.js";

describe("permissionRepository", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await createApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("creates a permission grant scoped to a tenant", async () => {
    const tenant = await createTestTenant(app);
    const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
    const tool = await createTestTool(tenant.tenantId);

    const grant = await permissionRepository.create({
      tenantId: tenant.tenantId,
      agentId: agent.id,
      toolId: tool.id,
    });

    expect(grant.isActive).toBe(true);
    expect(grant.parameterConstraints).toBeNull();
    expect(grant.callBudgetPerHour).toBeNull();

    await cleanupTenant(tenant.tenantId);
  });

  it("rejects a duplicate (agentId, toolId) grant", async () => {
    const tenant = await createTestTenant(app);
    const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
    const tool = await createTestTool(tenant.tenantId);

    await permissionRepository.create({ tenantId: tenant.tenantId, agentId: agent.id, toolId: tool.id });

    await expect(
      permissionRepository.create({ tenantId: tenant.tenantId, agentId: agent.id, toolId: tool.id })
    ).rejects.toThrow(); // P2002 — the @@unique([agentId, toolId]) constraint

    await cleanupTenant(tenant.tenantId);
  });

  it("findGrantWithContext returns the permission row's own isActive AND the agent/tool context", async () => {
    const tenant = await createTestTenant(app);
    const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
    const tool = await createTestTool(tenant.tenantId);
    await permissionRepository.create({ tenantId: tenant.tenantId, agentId: agent.id, toolId: tool.id });

    const row = await permissionRepository.findGrantWithContext(agent.id, tool.id, tenant.tenantId);

    expect(row).not.toBeNull();
    expect(row!.isActive).toBe(true);
    expect(row!.agent.isActive).toBe(true);
    expect(row!.tool.isActive).toBe(true);

    await cleanupTenant(tenant.tenantId);
  });

  it("findGrantWithContext also returns the tenant's deletedAt status", async () => {
    const tenant = await createTestTenant(app);
    const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
    const tool = await createTestTool(tenant.tenantId);
    await permissionRepository.create({ tenantId: tenant.tenantId, agentId: agent.id, toolId: tool.id });

    const row = await permissionRepository.findGrantWithContext(agent.id, tool.id, tenant.tenantId);

    expect(row).not.toBeNull();
    expect(row!.tenant.deletedAt).toBeNull();

    await cleanupTenant(tenant.tenantId);
  });

  it("findGrantWithContext returns null for a non-existent grant", async () => {
    const tenant = await createTestTenant(app);
    const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
    const tool = await createTestTool(tenant.tenantId);

    const row = await permissionRepository.findGrantWithContext(agent.id, tool.id, tenant.tenantId);
    expect(row).toBeNull();

    await cleanupTenant(tenant.tenantId);
  });
});