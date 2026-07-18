import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp } from "../app.js";
import { prisma } from "../lib/prisma.js";
import { checkPermission } from "../lib/permission-engine.js";
import { permissionRepository } from "../repositories/permission.repository.js";
import { agentRepository } from "../repositories/agent.repository.js";
import { toolRepository } from "../repositories/tool.repository.js";
import {
  createTestTenant,
  createTestAgent,
  createTestTool,
  cleanupTenant,
} from "./helpers/test-tenant.factory.js";

describe("checkPermission — permission engine", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await createApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("grants when permission, agent, tool, and tenant are all active", async () => {
    const tenant = await createTestTenant(app);
    const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
    const tool = await createTestTool(tenant.tenantId);
    await permissionRepository.create({ tenantId: tenant.tenantId, agentId: agent.id, toolId: tool.id });

    const result = await checkPermission(agent.id, tool.id, tenant.tenantId);
    expect(result).toEqual({ granted: true });

    await cleanupTenant(tenant.tenantId);
  });

  it("denies with reason 'not_found' when no grant row exists at all", async () => {
    const tenant = await createTestTenant(app);
    const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
    const tool = await createTestTool(tenant.tenantId);
    // deliberately: no permission grant created

    const result = await checkPermission(agent.id, tool.id, tenant.tenantId);
    expect(result.granted).toBe(false);
    if (!result.granted) expect(result.reason).toBe("not_found");

    await cleanupTenant(tenant.tenantId);
  });

  it("denies with reason 'tenant_suspended' when the tenant is soft-deleted mid-grant", async () => {
    const tenant = await createTestTenant(app);
    const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
    const tool = await createTestTool(tenant.tenantId);
    await permissionRepository.create({ tenantId: tenant.tenantId, agentId: agent.id, toolId: tool.id });

    await prisma.tenant.update({ where: { id: tenant.tenantId }, data: { deletedAt: new Date() } });

    const result = await checkPermission(agent.id, tool.id, tenant.tenantId);
    expect(result.granted).toBe(false);
    if (!result.granted) expect(result.reason).toBe("tenant_suspended");

    await cleanupTenant(tenant.tenantId);
  });

  /**
   * Missing from the original roadmap draft's checklist — but this
   * is the SINGLE MOST COMMON real path into a denial: it's exactly
   * what DELETE /:agentId/permissions/:toolId causes.
   */
  it("denies with reason 'permission_inactive' when the grant itself has been revoked", async () => {
    const tenant = await createTestTenant(app);
    const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
    const tool = await createTestTool(tenant.tenantId);
    await permissionRepository.create({ tenantId: tenant.tenantId, agentId: agent.id, toolId: tool.id });

    await permissionRepository.deactivate(agent.id, tool.id, tenant.tenantId);

    const result = await checkPermission(agent.id, tool.id, tenant.tenantId);
    expect(result.granted).toBe(false);
    if (!result.granted) expect(result.reason).toBe("permission_inactive");

    await cleanupTenant(tenant.tenantId);
  });

  it("denies with reason 'agent_inactive' when the agent is deactivated mid-grant", async () => {
    const tenant = await createTestTenant(app);
    const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
    const tool = await createTestTool(tenant.tenantId);
    await permissionRepository.create({ tenantId: tenant.tenantId, agentId: agent.id, toolId: tool.id });

    await agentRepository.setActiveStatus(agent.id, tenant.tenantId, false);

    const result = await checkPermission(agent.id, tool.id, tenant.tenantId);
    expect(result.granted).toBe(false);
    if (!result.granted) expect(result.reason).toBe("agent_inactive");

    await cleanupTenant(tenant.tenantId);
  });

  it("denies with reason 'tool_inactive' when the tool is deactivated mid-grant", async () => {
    const tenant = await createTestTenant(app);
    const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
    const tool = await createTestTool(tenant.tenantId);
    await permissionRepository.create({ tenantId: tenant.tenantId, agentId: agent.id, toolId: tool.id });

    // NOTE: setActiveStatus, not updateById — this is the tool
    // repository's actual (corrected) deactivation method name, per
    // the Week 2 Gate 3 regression test that exists precisely
    // because this method once silently targeted the wrong table.
    await toolRepository.setActiveStatus(tool.id, tenant.tenantId, false);

    const result = await checkPermission(agent.id, tool.id, tenant.tenantId);
    expect(result.granted).toBe(false);
    if (!result.granted) expect(result.reason).toBe("tool_inactive");

    await cleanupTenant(tenant.tenantId);
  });

  it("fails CLOSED with reason 'error' when the repository throws — never silently grants", async () => {
    const spy = vi
      .spyOn(permissionRepository, "findGrantWithContext")
      .mockRejectedValue(new Error("connection reset"));

    const result = await checkPermission("agent-x", "tool-y", "tenant-z");
    expect(result.granted).toBe(false);
    if (!result.granted) expect(result.reason).toBe("error");

    spy.mockRestore();
  });

  /**
   * The engine's own code comments claim a specific evaluation
   * order ("broadest scope first"). These tests verify that claim
   * actually holds, rather than trusting the comment.
   */
  describe("denial precedence — broadest scope wins when multiple conditions are true", () => {
    it("tenant_suspended takes priority over agent_inactive", async () => {
      const tenant = await createTestTenant(app);
      const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
      const tool = await createTestTool(tenant.tenantId);
      await permissionRepository.create({ tenantId: tenant.tenantId, agentId: agent.id, toolId: tool.id });

      await agentRepository.setActiveStatus(agent.id, tenant.tenantId, false);
      await prisma.tenant.update({ where: { id: tenant.tenantId }, data: { deletedAt: new Date() } });

      const result = await checkPermission(agent.id, tool.id, tenant.tenantId);
      expect(result.granted).toBe(false);
      if (!result.granted) expect(result.reason).toBe("tenant_suspended");

      await cleanupTenant(tenant.tenantId);
    });

    it("permission_inactive takes priority over agent_inactive and tool_inactive", async () => {
      const tenant = await createTestTenant(app);
      const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
      const tool = await createTestTool(tenant.tenantId);
      await permissionRepository.create({ tenantId: tenant.tenantId, agentId: agent.id, toolId: tool.id });

      await permissionRepository.deactivate(agent.id, tool.id, tenant.tenantId);
      await agentRepository.setActiveStatus(agent.id, tenant.tenantId, false);
      await toolRepository.setActiveStatus(tool.id, tenant.tenantId, false);

      const result = await checkPermission(agent.id, tool.id, tenant.tenantId);
      expect(result.granted).toBe(false);
      if (!result.granted) expect(result.reason).toBe("permission_inactive");

      await cleanupTenant(tenant.tenantId);
    });

    it("agent_inactive takes priority over tool_inactive", async () => {
      const tenant = await createTestTenant(app);
      const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
      const tool = await createTestTool(tenant.tenantId);
      await permissionRepository.create({ tenantId: tenant.tenantId, agentId: agent.id, toolId: tool.id });

      await agentRepository.setActiveStatus(agent.id, tenant.tenantId, false);
      await toolRepository.setActiveStatus(tool.id, tenant.tenantId, false);

      const result = await checkPermission(agent.id, tool.id, tenant.tenantId);
      expect(result.granted).toBe(false);
      if (!result.granted) expect(result.reason).toBe("agent_inactive");

      await cleanupTenant(tenant.tenantId);
    });
  });
});