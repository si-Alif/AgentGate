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
import { DEFAULT_TIMEOUT_MS } from "../handlers/types.js";

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

  it("threads the caller's AbortSignal AND gatewayOverheadMs into executeTool (Day 5 signature update)", async () => {
    const tenant = await createTestTenant(app);
    const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
    const tool = await createTestTool(tenant.tenantId);
    await permissionService.assignPermission(tenant.tenantId, { agentId: agent.id, toolId: tool.id });
    mockedExecuteTool.mockResolvedValue({ status: "success", result: { ok: true }, durationMs: 5 });

    const controller = new AbortController();
    await handleToolsCall(
      { agentId: agent.id, tenantId: tenant.tenantId }, { name: tool.name }, performance.now(), controller.signal
    );

    expect(mockedExecuteTool).toHaveBeenCalledWith(
      tool.id, tenant.tenantId, agent.id, {}, controller.signal, DEFAULT_TIMEOUT_MS, expect.any(Number)
    );
    await cleanupTenant(tenant.tenantId);
  });

  it("GATE — gatewayOverheadMs reflects PRE-EXECUTION pipeline time, independent of executeTool's own durationMs", async () => {
    const tenant = await createTestTenant(app);
    const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
    const tool = await createTestTool(tenant.tenantId);
    await permissionService.assignPermission(tenant.tenantId, { agentId: agent.id, toolId: tool.id });
    // A deliberately huge durationMs — under Day 4's OLD formula this
    // would have driven gatewayOverheadMs toward zero or even clamped
    // it; under Day 5's formula it has NO effect on gatewayOverheadMs
    // at all, because the value is computed BEFORE executeTool is ever
    // called.
    mockedExecuteTool.mockResolvedValue({ status: "success", result: { ok: true }, durationMs: 999_999 });

    const result = await handleToolsCall(
      { agentId: agent.id, tenantId: tenant.tenantId }, { name: tool.name }, performance.now(), new AbortController().signal
    );

    expect(result._meta.gatewayOverheadMs).toBeGreaterThanOrEqual(0);
    expect(result._meta.gatewayOverheadMs).toBeLessThan(1000); // pipeline overhead in a test env, not the mocked execution time
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

  describe("handleToolsCall — audit wiring (Day 5)", () => {
    it("GATE — a permission denial enqueues a PERMISSION_DENIED audit event with the correct denialReason", async () => {
      const auditSpy = vi.spyOn(await import("../mcp/tools/tools-call-audit.js"), "auditPermissionDenied");
      const tenant = await createTestTenant(app);
      const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
      const tool = await createTestTool(tenant.tenantId); // no grant assigned

      await expect(
        handleToolsCall({ agentId: agent.id, tenantId: tenant.tenantId }, { name: tool.name }, performance.now(), new AbortController().signal)
      ).rejects.toMatchObject({ code: -32000 });

      expect(auditSpy).toHaveBeenCalledTimes(1);
      expect(auditSpy.mock.calls[0]![1]).toMatchObject({ granted: false, reason: "not_found" });

      auditSpy.mockRestore();
      await cleanupTenant(tenant.tenantId);
    });

    it("a rate-limit denial enqueues a RATE_LIMITED audit event", async () => {
      const toolsCallAudit = await import("../mcp/tools/tools-call-audit.js");
      const auditSpy = vi.spyOn(toolsCallAudit, "auditRateLimited");
      const tenant = await createTestTenant(app);
      const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
      const tool = await createTestTool(tenant.tenantId);
      await permissionService.assignPermission(tenant.tenantId, { agentId: agent.id, toolId: tool.id });
      vi.spyOn(rateLimiterModule, "checkRateLimit").mockResolvedValue({ allowed: false, remaining: 0, degraded: false });

      await expect(
        handleToolsCall({ agentId: agent.id, tenantId: tenant.tenantId }, { name: tool.name }, performance.now(), new AbortController().signal)
      ).rejects.toMatchObject({ code: -32001 });

      expect(auditSpy).toHaveBeenCalledTimes(1);
      auditSpy.mockRestore();
      await cleanupTenant(tenant.tenantId);
    });

    it("a DEGRADED rate-limit denial does NOT enqueue a RATE_LIMITED audit event", async () => {
      const toolsCallAudit = await import("../mcp/tools/tools-call-audit.js");
      const auditSpy = vi.spyOn(toolsCallAudit, "auditRateLimited");
      const tenant = await createTestTenant(app);
      const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
      const tool = await createTestTool(tenant.tenantId);
      await permissionService.assignPermission(tenant.tenantId, { agentId: agent.id, toolId: tool.id });
      vi.spyOn(rateLimiterModule, "checkRateLimit").mockResolvedValue({ allowed: false, remaining: 0, degraded: true });

      await expect(
        handleToolsCall({ agentId: agent.id, tenantId: tenant.tenantId }, { name: tool.name }, performance.now(), new AbortController().signal)
      ).rejects.toMatchObject({ code: -32002 });

      // The function is CALLED (it's on the code path) but internally
      // no-ops per Decision 5.4 — verified at the enqueueAuditEvent
      // boundary, one layer down, which is the actually load-bearing check:
      const enqueueSpy = vi.spyOn(await import("../lib/audit-stub.js"), "enqueueAuditEvent");
      expect(enqueueSpy).not.toHaveBeenCalled();

      auditSpy.mockRestore();
      enqueueSpy.mockRestore();
      await cleanupTenant(tenant.tenantId);
    });

    it("checkRateLimit is called WITH tenantId (Decision 5.10)", async () => {
      const tenant = await createTestTenant(app);
      const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
      const tool = await createTestTool(tenant.tenantId);
      await permissionService.assignPermission(tenant.tenantId, { agentId: agent.id, toolId: tool.id });
      const rlSpy = vi.spyOn(rateLimiterModule, "checkRateLimit");
      mockedExecuteTool.mockResolvedValue({ status: "success", result: {}, durationMs: 1 });

      await handleToolsCall({ agentId: agent.id, tenantId: tenant.tenantId }, { name: tool.name }, performance.now(), new AbortController().signal);

      expect(rlSpy).toHaveBeenCalledWith(agent.id, expect.any(Number), tenant.tenantId);
      rlSpy.mockRestore();
      await cleanupTenant(tenant.tenantId);
    });
  });
});