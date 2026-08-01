import type { FastifyInstance } from "fastify";
import { createApp } from "../app.js";
import { describe, it, expect, vi  , beforeAll , afterAll} from "vitest";
import { handleToolsList } from "../mcp/tools/tools-list-handler.js";
import { permissionRepository } from "../repositories/permission.repository.js";
import { permissionService } from "../services/permission.service.js";
import { toolService } from "../services/tool.service.js";
import { prisma } from "../lib/prisma.js";
import { McpGatewayError } from "../mcp/errors/mcp-error-taxonomy.js";
import {
  createTestTenant,
  createTestAgent,
  createTestTool,
  cleanupTenant,
} from "./helpers/test-tenant.factory.js";

describe("handleToolsList", () => {

  let app: FastifyInstance;

  beforeAll(async () => {
    app = await createApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });


  it("CHECKPOINT — a cold cache resolves via Postgres and populates the cache", async () => {
    const tenant = await createTestTenant(app);
    const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
    const tool = await createTestTool(tenant.tenantId);
    await permissionService.assignPermission(tenant.tenantId, { agentId: agent.id, toolId: tool.id });

    const result = await handleToolsList({ agentId: agent.id, tenantId: tenant.tenantId });
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0]).toEqual({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema });
    expect(result.cacheScope).toBe("agent");
    expect(result.ttlMs).toBeGreaterThan(0);

    await cleanupTenant(tenant.tenantId);
  });

  it("CHECKPOINT — a warm cache resolves WITHOUT touching Postgres (call-count assertion)", async () => {
    const tenant = await createTestTenant(app);
    const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
    const tool = await createTestTool(tenant.tenantId);
    await permissionService.assignPermission(tenant.tenantId, { agentId: agent.id, toolId: tool.id });

    const identity = { agentId: agent.id, tenantId: tenant.tenantId };
    await handleToolsList(identity); // warms the cache

    const spy = vi.spyOn(permissionRepository, "listActiveGrantsForAgent");
    const second = await handleToolsList(identity);
    expect(second.tools).toHaveLength(1);
    expect(spy).not.toHaveBeenCalled();

    spy.mockRestore();
    await cleanupTenant(tenant.tenantId);
  });

  it("CHECKPOINT — granting a NEW permission is reflected on the very next call, well inside the TTL window (proves invalidation, not TTL luck)", async () => {
    const tenant = await createTestTenant(app);
    const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
    const toolA = await createTestTool(tenant.tenantId);
    const toolB = await createTestTool(tenant.tenantId);
    await permissionService.assignPermission(tenant.tenantId, { agentId: agent.id, toolId: toolA.id });

    const identity = { agentId: agent.id, tenantId: tenant.tenantId };
    const before = await handleToolsList(identity); // warms cache with just toolA
    expect(before.tools.map((t) => t.name)).toEqual([toolA.name]);

    await permissionService.assignPermission(tenant.tenantId, { agentId: agent.id, toolId: toolB.id });

    const spy = vi.spyOn(permissionRepository, "listActiveGrantsForAgent");
    const after = await handleToolsList(identity);
    expect(after.tools.map((t) => t.name).sort()).toEqual([toolA.name, toolB.name].sort());
    expect(spy).toHaveBeenCalledTimes(1); // proves this was a FRESH lookup, not a stale cache hit

    spy.mockRestore();
    await cleanupTenant(tenant.tenantId);
  });

  it("CHECKPOINT — revoking a permission is reflected on the very next call", async () => {
    const tenant = await createTestTenant(app);
    const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
    const tool = await createTestTool(tenant.tenantId);
    await permissionService.assignPermission(tenant.tenantId, { agentId: agent.id, toolId: tool.id });

    const identity = { agentId: agent.id, tenantId: tenant.tenantId };
    await handleToolsList(identity); // warms cache

    await permissionService.revokePermission(tenant.tenantId, agent.id, tool.id);

    const after = await handleToolsList(identity);
    expect(after.tools).toHaveLength(0);

    await cleanupTenant(tenant.tenantId);
  });

  it("GATE — deactivating a tool invalidates EVERY agent's cache in that tenant via the broadcast path, not just one", async () => {
    const tenant = await createTestTenant(app);
    const { agent: agentX } = await createTestAgent(tenant.tenantId, tenant.userId);
    const { agent: agentY } = await createTestAgent(tenant.tenantId, tenant.userId);
    const sharedTool = await createTestTool(tenant.tenantId);
    await permissionService.assignPermission(tenant.tenantId, { agentId: agentX.id, toolId: sharedTool.id });
    await permissionService.assignPermission(tenant.tenantId, { agentId: agentY.id, toolId: sharedTool.id });

    const identityX = { agentId: agentX.id, tenantId: tenant.tenantId };
    const identityY = { agentId: agentY.id, tenantId: tenant.tenantId };
    await handleToolsList(identityX); // warm both
    await handleToolsList(identityY);

    await toolService.deactivateTool(sharedTool.id, tenant.tenantId);

    const afterX = await handleToolsList(identityX);
    const afterY = await handleToolsList(identityY);
    expect(afterX.tools).toHaveLength(0);
    expect(afterY.tools).toHaveLength(0);

    await cleanupTenant(tenant.tenantId);
  });

  it("Decision 3.5 — a tenant suspended AFTER the cache is warm returns the stale (but bounded, ≤TTL) list — an explicitly accepted, tested tradeoff, not a silent gap", async () => {
    const tenant = await createTestTenant(app);
    const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
    const tool = await createTestTool(tenant.tenantId);
    await permissionService.assignPermission(tenant.tenantId, { agentId: agent.id, toolId: tool.id });

    const identity = { agentId: agent.id, tenantId: tenant.tenantId };
    const before = await handleToolsList(identity);
    expect(before.tools).toHaveLength(1);

    await prisma.tenant.update({ where: { id: tenant.tenantId }, data: { deletedAt: new Date() } });

    const stillWarm = await handleToolsList(identity);
    expect(stillWarm.tools).toHaveLength(1); // documents the accepted, bounded staleness — see §A.5

    await cleanupTenant(tenant.tenantId);
  });

  it("maps a genuine repository failure to a McpGatewayError with code -32002, not a bare Error", async () => {
    const spy = vi.spyOn(permissionRepository, "listActiveGrantsForAgent").mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(handleToolsList({ agentId: "a", tenantId: "t" })).rejects.toSatisfy(
      (err: unknown) => err instanceof McpGatewayError && err.code === -32002
    );

    spy.mockRestore();
  });
});