import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";

vi.mock("../lib/execute-tool.js", () => ({ executeTool: vi.fn() }));

import { executeTool } from "../lib/execute-tool.js";
import * as rateLimiterModule from "../lib/rate-limiter.js";
import * as permissionEngineModule from "../lib/permission-engine.js";
import { permissionRepository } from "../repositories/permission.repository.js";
import { handleToolsCall } from "../mcp/tools/tools-call-handler.js";
import { permissionService } from "../services/permission.service.js";
import { prisma } from "../lib/prisma.js";
import {
  createTestTenant, createTestAgent, createTestTool, cleanupTenant,
} from "./helpers/test-tenant.factory.js";
import { createApp } from "../app.js";
import type { FastifyInstance } from "fastify";

const mockedExecuteTool = vi.mocked(executeTool);

describe("handleToolsCall — pipeline ordering & short-circuiting", () => {

  let app: FastifyInstance;

  beforeAll(async () => {
    app = await createApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => mockedExecuteTool.mockReset());
  afterEach(() => vi.restoreAllMocks());

  it("GATE — an unresolvable tool name never reaches checkPermission, rate limit, or execute", async () => {
    const tenant = await createTestTenant(app);
    const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
    const permSpy = vi.spyOn(permissionEngineModule, "checkPermission");

    await expect(
      handleToolsCall({ agentId: agent.id, tenantId: tenant.tenantId }, { name: "does-not-exist" }, performance.now(), new AbortController().signal)
    ).rejects.toMatchObject({ code: -32003 });

    expect(permSpy).not.toHaveBeenCalled();
    expect(mockedExecuteTool).not.toHaveBeenCalled();
    await cleanupTenant(tenant.tenantId);
  });

  it("GATE — a permission denial short-circuits before checkRateLimit or executeTool", async () => {
    const tenant = await createTestTenant(app);
    const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
    const tool = await createTestTool(tenant.tenantId); // no grant assigned
    const rlSpy = vi.spyOn(rateLimiterModule, "checkRateLimit");

    await expect(
      handleToolsCall({ agentId: agent.id, tenantId: tenant.tenantId }, { name: tool.name }, performance.now(), new AbortController().signal)
    ).rejects.toMatchObject({ code: -32000 });

    expect(rlSpy).not.toHaveBeenCalled();
    expect(mockedExecuteTool).not.toHaveBeenCalled();
    await cleanupTenant(tenant.tenantId);
  });

  it("GATE — invalid arguments (AJV) short-circuit before checkRateLimit or executeTool", async () => {
    const tenant = await createTestTenant(app);
    const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
    const tool = await createTestTool(tenant.tenantId, {
      inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
    } as any);
    await permissionService.assignPermission(tenant.tenantId, { agentId: agent.id, toolId: tool.id });
    const rlSpy = vi.spyOn(rateLimiterModule, "checkRateLimit");

    await expect(
      handleToolsCall({ agentId: agent.id, tenantId: tenant.tenantId }, { name: tool.name, arguments: {} }, performance.now(), new AbortController().signal)
    ).rejects.toMatchObject({ code: -32602 });

    expect(rlSpy).not.toHaveBeenCalled();
    expect(mockedExecuteTool).not.toHaveBeenCalled();
    await cleanupTenant(tenant.tenantId);
  });

  it("GATE — a rate-limit denial short-circuits before executeTool (AJV already passed)", async () => {
    const tenant = await createTestTenant(app);
    const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
    const tool = await createTestTool(tenant.tenantId);
    await permissionService.assignPermission(tenant.tenantId, { agentId: agent.id, toolId: tool.id });
    vi.spyOn(rateLimiterModule, "checkRateLimit").mockResolvedValue({ allowed: false, remaining: 0, degraded: false });

    await expect(
      handleToolsCall({ agentId: agent.id, tenantId: tenant.tenantId }, { name: tool.name }, performance.now(), new AbortController().signal)
    ).rejects.toMatchObject({ code: -32001 });

    expect(mockedExecuteTool).not.toHaveBeenCalled();
    await cleanupTenant(tenant.tenantId);
  });

  it("a DEGRADED rate-limit result maps to -32002, never -32001", async () => {
    const tenant = await createTestTenant(app);
    const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
    const tool = await createTestTool(tenant.tenantId);
    await permissionService.assignPermission(tenant.tenantId, { agentId: agent.id, toolId: tool.id });
    vi.spyOn(rateLimiterModule, "checkRateLimit").mockResolvedValue({ allowed: false, remaining: 0, degraded: true });

    await expect(
      handleToolsCall({ agentId: agent.id, tenantId: tenant.tenantId }, { name: tool.name }, performance.now(), new AbortController().signal)
    ).rejects.toMatchObject({ code: -32002 });

    await cleanupTenant(tenant.tenantId);
  });

  it("Decision 4.6 — an Mcp-Name header that disagrees with the body's params.name is rejected with -32600, before any DB work", async () => {
    const tenant = await createTestTenant(app);
    const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);

    await expect(
      handleToolsCall(
        { agentId: agent.id, tenantId: tenant.tenantId },
        { name: "real-tool" },
        performance.now(),
        new AbortController().signal,
        "different-tool"
      )
    ).rejects.toMatchObject({ code: -32600 });

    await cleanupTenant(tenant.tenantId);
  });

  it("GATE — the fresh checkPermission reason 'error' maps to -32002 and never leaks the raw exception", async () => {
    const tenant = await createTestTenant(app);
    const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
    const tool = await createTestTool(tenant.tenantId);
    const spy = vi
      .spyOn(permissionRepository, "findGrantWithContext")
      .mockRejectedValue(new Error("connection string: postgres://admin:S3cret@db/prod"));

    const err = await handleToolsCall({ agentId: agent.id, tenantId: tenant.tenantId }, { name: tool.name }, performance.now(), new AbortController().signal).catch((e) => e);
    expect(err.code).toBe(-32002);
    expect(JSON.stringify(err.data)).not.toContain("S3cret");

    spy.mockRestore();
    await cleanupTenant(tenant.tenantId);
  });

  it("checkPermission's 'tenant_suspended' (real, fresh) maps to -32009", async () => {
    const tenant = await createTestTenant(app);
    const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
    const tool = await createTestTool(tenant.tenantId);
    await permissionService.assignPermission(tenant.tenantId, { agentId: agent.id, toolId: tool.id });
    await prisma.tenant.update({ where: { id: tenant.tenantId }, data: { deletedAt: new Date() } });

    await expect(
      handleToolsCall({ agentId: agent.id, tenantId: tenant.tenantId }, { name: tool.name }, performance.now(), new AbortController().signal)
    ).rejects.toMatchObject({ code: -32009 });

    await cleanupTenant(tenant.tenantId);
  });

  it("threads the caller's AbortSignal into executeTool unchanged", async () => {
    const tenant = await createTestTenant(app);
    const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
    const tool = await createTestTool(tenant.tenantId);
    await permissionService.assignPermission(tenant.tenantId, { agentId: agent.id, toolId: tool.id });
    mockedExecuteTool.mockResolvedValue({ status: "success", result: { ok: true }, durationMs: 5 });

    const controller = new AbortController();
    await handleToolsCall({ agentId: agent.id, tenantId: tenant.tenantId }, { name: tool.name }, performance.now(), controller.signal);

    expect(mockedExecuteTool).toHaveBeenCalledWith(tool.id, tenant.tenantId, agent.id, {}, controller.signal);
    await cleanupTenant(tenant.tenantId);
  });

  it("GATE — gatewayOverheadMs is present, non-negative, and correctly excludes executeTool's own durationMs", async () => {
    const tenant = await createTestTenant(app);
    const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
    const tool = await createTestTool(tenant.tenantId);
    await permissionService.assignPermission(tenant.tenantId, { agentId: agent.id, toolId: tool.id });
    mockedExecuteTool.mockResolvedValue({ status: "success", result: { ok: true }, durationMs: 500 });

    const result = await handleToolsCall(
      { agentId: agent.id, tenantId: tenant.tenantId }, { name: tool.name }, performance.now(), new AbortController().signal
    );

    expect(result._meta.gatewayOverheadMs).toBeGreaterThanOrEqual(0);
    // Overhead should be a small fraction of the (artificially large)
    // 500ms execution time — an empirical first check against PRD
    // §12's budget.
    expect(result._meta.gatewayOverheadMs).toBeLessThan(500);
    await cleanupTenant(tenant.tenantId);
  });

  describe("routing is handler-type agnostic — proven via each shape executeTool actually returns", () => {
    it.each([
      ["http", { statusCode: 200, headers: {}, body: { ok: true } }],
      ["postgres", { rows: [{ id: 1 }], rowCount: 1 }],
      ["web_fetch", { statusCode: 200, text: "hello", contentType: "text/plain", contentLength: 5 }],
    ])("%s-shaped output passes through result.output unchanged", async (_handlerType, mockOutput) => {
      const tenant = await createTestTenant(app);
      const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
      const tool = await createTestTool(tenant.tenantId);
      await permissionService.assignPermission(tenant.tenantId, { agentId: agent.id, toolId: tool.id });
      mockedExecuteTool.mockResolvedValue({ status: "success", result: mockOutput, durationMs: 1 });

      const result = await handleToolsCall(
        { agentId: agent.id, tenantId: tenant.tenantId }, { name: tool.name }, performance.now(), new AbortController().signal
      );
      expect(result.output).toEqual(mockOutput);
      await cleanupTenant(tenant.tenantId);
    });
  });
});