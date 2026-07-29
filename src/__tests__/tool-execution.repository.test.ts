import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp } from "../app.js";
import crypto from "node:crypto";
import { toolExecutionRepository } from "../repositories/tool-execution.repository.js";
import { createTestTenant, createTestAgent, createTestTool, cleanupTenant } from "./helpers/test-tenant.factory.js";

describe("toolExecutionRepository", () => {

  let app: FastifyInstance;

  beforeAll(async () => {
    app = await createApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });


  it("creates a row keyed by a client-supplied id", async () => {
    const tenant = await createTestTenant(app);
    const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
    const tool = await createTestTool(tenant.tenantId);
    const id = crypto.randomUUID();

    const row = await toolExecutionRepository.create({
      id,
      tenantId: tenant.tenantId,
      agentId: agent.id,
      toolId: tool.id,
      status: "success",
      durationMs: 42,
      startedAt: new Date(),
      completedAt: new Date(),
      inputTruncated: false,
      outputTruncated: false,
    });

    expect(row.id).toBe(id);
    await cleanupTenant(tenant.tenantId);
  });

  it("rejects a second create() with the same id — THIS is the idempotency guarantee, not an incidental constraint", async () => {
    const tenant = await createTestTenant(app);
    const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
    const tool = await createTestTool(tenant.tenantId);
    const id = crypto.randomUUID();
    const base = {
      id, tenantId: tenant.tenantId, agentId: agent.id, toolId: tool.id,
      status: "success", durationMs: 1, startedAt: new Date(), completedAt: new Date(),
      inputTruncated: false, outputTruncated: false,
    };

    await toolExecutionRepository.create(base);
    await expect(toolExecutionRepository.create(base)).rejects.toMatchObject({ code: "P2002" });

    await cleanupTenant(tenant.tenantId);
  });
});