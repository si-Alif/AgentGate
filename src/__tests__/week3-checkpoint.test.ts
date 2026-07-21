import { describe, it, expect, vi, beforeEach, beforeAll , afterAll} from "vitest";
import crypto from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { createApp } from "../app.js";
import type { FastifyInstance } from "fastify";
import {
  checkRateLimit,
  getRateLimiterBreaker,
  rateLimiterRedis,
} from "../lib/rate-limiter.js";
import { checkPermission } from "../lib/permission-engine.js";
import { permissionRepository } from "../repositories/permission.repository.js";
import { permissionService } from "../services/permission.service.js";
import { agentRepository } from "../repositories/agent.repository.js";
import {
  createTestTenant,
  createTestAgent,
  createTestTool,
  cleanupTenant,
} from "./helpers/test-tenant.factory.js";

describe("Week 3 Proof Checkpoint", () => {

  let app: FastifyInstance;

  beforeAll(async () => {
    app = await createApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });


  beforeEach(() => {
    getRateLimiterBreaker().reset();
  });

  it("GATE 1 — concurrency: exactly 10 allowed / 10 denied under 20 simultaneous calls, limit=10", async () => {
    const agentId = `gate1-${crypto.randomUUID()}`;
    const results = await Promise.all(
      Array.from({ length: 20 }, () => checkRateLimit(agentId, 10))
    );
    expect(results.filter((r) => r.allowed).length).toBe(10);
    expect(results.filter((r) => !r.allowed).length).toBe(10);
  });

  it("GATE 2 — cross-tenant isolation: Tenant A cannot assign a permission touching Tenant B's agent or tool", async () => {
    const tenantA = await createTestTenant(app);
    const tenantB = await createTestTenant(app);
    const { agent: agentA } = await createTestAgent(tenantA.tenantId, tenantA.userId);
    const toolB = await createTestTool(tenantB.tenantId);

    await expect(
      permissionService.assignPermission(tenantA.tenantId, {
        agentId: agentA.id,
        toolId: toolB.id,
      })
    ).rejects.toThrow();

    await cleanupTenant(tenantA.tenantId);
    await cleanupTenant(tenantB.tenantId);
  });

  it("GATE 3 — tenant suspension immediately blocks checkPermission", async () => {
    const tenant = await createTestTenant(app);
    const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
    const tool = await createTestTool(tenant.tenantId);
    await permissionRepository.create({
      tenantId: tenant.tenantId,
      agentId: agent.id,
      toolId: tool.id,
    });

    expect((await checkPermission(agent.id, tool.id, tenant.tenantId)).granted).toBe(
      true
    );

    await prisma.tenant.update({
      where: { id: tenant.tenantId },
      data: { deletedAt: new Date() },
    });

    const result = await checkPermission(agent.id, tool.id, tenant.tenantId);
    expect(result.granted).toBe(false);
    expect((result as any).reason).toBe("tenant_suspended");

    await cleanupTenant(tenant.tenantId);
  });

  it("GATE 4 — agent deactivation immediately blocks checkPermission", async () => {
    const tenant = await createTestTenant(app);
    const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
    const tool = await createTestTool(tenant.tenantId);
    await permissionRepository.create({
      tenantId: tenant.tenantId,
      agentId: agent.id,
      toolId: tool.id,
    });

    expect((await checkPermission(agent.id, tool.id, tenant.tenantId)).granted).toBe(
      true
    );

    await agentRepository.setActiveStatus(agent.id, tenant.tenantId, false);

    const result = await checkPermission(agent.id, tool.id, tenant.tenantId);
    expect(result.granted).toBe(false);
    expect((result as any).reason).toBe("agent_inactive");

    await cleanupTenant(tenant.tenantId);
  });

  it("GATE 4b — tool deactivation immediately blocks checkPermission", async () => {
    const tenant = await createTestTenant(app);
    const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
    const tool = await createTestTool(tenant.tenantId);
    await permissionRepository.create({
      tenantId: tenant.tenantId,
      agentId: agent.id,
      toolId: tool.id,
    });

    const { toolRepository } = await import(
      "../repositories/tool.repository.js"
    );
    await toolRepository.setActiveStatus(tool.id, tenant.tenantId,  false );

    const result = await checkPermission(agent.id, tool.id, tenant.tenantId);
    expect(result.granted).toBe(false);
    expect((result as any).reason).toBe("tool_inactive");

    await cleanupTenant(tenant.tenantId);
  });

  it("GATE 4c — permission revocation (inactive) immediately blocks checkPermission", async () => {
    const tenant = await createTestTenant(app);
    const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
    const tool = await createTestTool(tenant.tenantId);
    await permissionRepository.create({
      tenantId: tenant.tenantId,
      agentId: agent.id,
      toolId: tool.id,
    });

    await permissionRepository.deactivate(agent.id, tool.id, tenant.tenantId);

    const result = await checkPermission(agent.id, tool.id, tenant.tenantId);
    expect(result.granted).toBe(false);
    expect((result as any).reason).toBe("permission_inactive");

    await cleanupTenant(tenant.tenantId);
  });

  it("GATE 5 — breaker class-level state machine: CLOSED -> OPEN -> HALF_OPEN -> CLOSED", async () => {
    const breaker = getRateLimiterBreaker();
    breaker.reset();

    expect(breaker.getState()).toBe("CLOSED");
    breaker.onFailure();
    breaker.onFailure();
    breaker.onFailure();
    expect(breaker.getState()).toBe("OPEN");

    await new Promise((r) => setTimeout(r, 20));
    (breaker as any).lastOpenedAt = Date.now() - 20_000;
    breaker.canAttempt();

    breaker.onSuccess();
    expect(breaker.getState()).toBe("CLOSED");
  });

  it("GATE 5b — breaker recovery THROUGH checkRateLimit() (integration, not class-only)", async () => {
    vi.useFakeTimers();
    const breaker = getRateLimiterBreaker();
    breaker.reset();

    const spy = vi.spyOn(rateLimiterRedis, "rateLimitIncr");

    // Trip OPEN
    spy.mockRejectedValue(new Error("ECONNREFUSED"));
    await checkRateLimit("gate5b", 10);
    await checkRateLimit("gate5b", 10);
    await checkRateLimit("gate5b", 10);
    expect(breaker.getState()).toBe("OPEN");

    // Advance cooldown
    vi.advanceTimersByTime(16_000);

    // Recovery
    spy.mockResolvedValue(1);
    const result = await checkRateLimit("gate5b", 10);
    expect(result.degraded).toBe(false);
    expect(breaker.getState()).toBe("CLOSED");

    spy.mockRestore();
    vi.useRealTimers();
  });
});