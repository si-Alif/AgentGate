import type { FastifyInstance } from "fastify";
import { createApp } from "../app.js";
import { describe, it, expect  , beforeAll , afterAll} from "vitest";
import { permissionRepository } from "../repositories/permission.repository.js";
import { prisma } from "../lib/prisma.js";
import {
  createTestTenant,
  createTestAgent,
  createTestTool,
  cleanupTenant,
} from "./helpers/test-tenant.factory.js";

describe("permissionRepository.listActiveGrantsForAgent", () => {

  let app: FastifyInstance;

  beforeAll(async () => {
    app = await createApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns only the tool fields needed for a descriptor, for an active grant on an active tool", async () => {
    const tenant = await createTestTenant(app);
    const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
    const tool = await createTestTool(tenant.tenantId);
    await permissionRepository.create({ tenantId: tenant.tenantId, agentId: agent.id, toolId: tool.id });

    const rows = await permissionRepository.listActiveGrantsForAgent(agent.id, tenant.tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tool).toMatchObject({ name: tool.name });
    expect(rows[0]!.tool).toHaveProperty("inputSchema");

    await cleanupTenant(tenant.tenantId);
  });

  it("excludes a REVOKED permission", async () => {
    const tenant = await createTestTenant(app);
    const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
    const tool = await createTestTool(tenant.tenantId);
    await permissionRepository.create({ tenantId: tenant.tenantId, agentId: agent.id, toolId: tool.id });
    await permissionRepository.deactivate(agent.id, tool.id, tenant.tenantId);

    expect(await permissionRepository.listActiveGrantsForAgent(agent.id, tenant.tenantId)).toHaveLength(0);
    await cleanupTenant(tenant.tenantId);
  });

  it("excludes a grant to a DEACTIVATED tool, even though the permission row itself is still active", async () => {
    const tenant = await createTestTenant(app);
    const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
    const tool = await createTestTool(tenant.tenantId);
    await permissionRepository.create({ tenantId: tenant.tenantId, agentId: agent.id, toolId: tool.id });

    const { toolRepository } = await import("../repositories/tool.repository.js");
    await toolRepository.setActiveStatus(tool.id, tenant.tenantId, false);

    expect(await permissionRepository.listActiveGrantsForAgent(agent.id, tenant.tenantId)).toHaveLength(0);
    await cleanupTenant(tenant.tenantId);
  });

  it("excludes everything once the TENANT is suspended, even with fully active permission+tool rows", async () => {
    const tenant = await createTestTenant(app);
    const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
    const tool = await createTestTool(tenant.tenantId);
    await permissionRepository.create({ tenantId: tenant.tenantId, agentId: agent.id, toolId: tool.id });

    await prisma.tenant.update({ where: { id: tenant.tenantId }, data: { deletedAt: new Date() } });

    expect(await permissionRepository.listActiveGrantsForAgent(agent.id, tenant.tenantId)).toHaveLength(0);
    await cleanupTenant(tenant.tenantId);
  });

  it("orders results deterministically by tool name", async () => {
    const tenant = await createTestTenant(app);
    const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
    const toolB = await createTestTool(tenant.tenantId, { name: "zzz-tool" } as any);
    const toolA = await createTestTool(tenant.tenantId, { name: "aaa-tool" } as any);
    await permissionRepository.create({ tenantId: tenant.tenantId, agentId: agent.id, toolId: toolB.id });
    await permissionRepository.create({ tenantId: tenant.tenantId, agentId: agent.id, toolId: toolA.id });

    const rows = await permissionRepository.listActiveGrantsForAgent(agent.id, tenant.tenantId);
    expect(rows.map((r) => r.tool.name)).toEqual(["aaa-tool", "zzz-tool"]);

    await cleanupTenant(tenant.tenantId);
  });
});