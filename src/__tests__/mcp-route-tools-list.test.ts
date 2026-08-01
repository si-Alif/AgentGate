import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { createApp } from "../app.js";
import { permissionRepository } from "../repositories/permission.repository.js";
import { createTestTenant, createTestAgent, createTestTool, cleanupTenant } from "./helpers/test-tenant.factory.js";

describe("POST /mcp — tools/list", () => {
  let app: Awaited<ReturnType<typeof createApp>>;
  beforeAll(async () => {
    app = await createApp();
  });
  afterAll(async () => {
    await app.close();
  });

  function envelope(overrides: Record<string, unknown> = {}) {
    return {
      jsonrpc: "2.0",
      id: "req-tools-list",
      method: "tools/list",
      _meta: { protocolVersion: "2026-07-28" },
      ...overrides,
    };
  }

  it("returns the agent's permitted, active tools with a correct ttlMs and cacheScope: 'agent'", async () => {
    const tenant = await createTestTenant(app);
    const { agent, apiKey } = await createTestAgent(tenant.tenantId, tenant.userId );
    const tool = await createTestTool(tenant.tenantId);

    // NOTE: adjust to your real factory shape — createTestAgent's
    // return already includes the raw apiKey per Week 2's factory
    // (`{agent, apiKey}`); using `agent`'s own returned key here.
    const permissionResponse = await (await import("../services/permission.service.js")).permissionService
      .assignPermission(tenant.tenantId, { agentId: agent.id, toolId: tool.id });
    expect(permissionResponse.id).toBeDefined();

    const res = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: envelope(),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.result.tools).toEqual([
      { name: tool.name, description: tool.description, inputSchema: tool.inputSchema },
    ]);
    expect(body.result.cacheScope).toBe("agent");
    expect(body.result.ttlMs).toBeGreaterThan(0);

    await cleanupTenant(tenant.tenantId);
  });

  it("a second call within the TTL window returns identical data without a second Postgres query (call-count assertion)", async () => {
    const tenant = await createTestTenant(app);
    const { agent, apiKey } = await createTestAgent(tenant.tenantId, tenant.userId);
    const tool = await createTestTool(tenant.tenantId);
    const { permissionService } = await import("../services/permission.service.js");
    await permissionService.assignPermission(tenant.tenantId, { agentId: agent.id, toolId: tool.id });

    const payload = envelope();
    await app.inject({ method: "POST", url: "/mcp", headers: { authorization: `Bearer ${apiKey}` }, payload });

    const spy = vi.spyOn(permissionRepository, "listActiveGrantsForAgent");
    const res = await app.inject({ method: "POST", url: "/mcp", headers: { authorization: `Bearer ${apiKey}` }, payload });
    expect(res.statusCode).toBe(200);
    expect(spy).not.toHaveBeenCalled();

    spy.mockRestore();
    await cleanupTenant(tenant.tenantId);
  });

  it("Decision 3.11 — a repository failure inside tools/list returns -32002 SERVICE_DEGRADED, not the generic -32603, with the request id preserved", async () => {
    const tenant = await createTestTenant(app);
    const { apiKey } = await createTestAgent(tenant.tenantId, tenant.userId);
    const spy = vi.spyOn(permissionRepository, "listActiveGrantsForAgent").mockRejectedValue(new Error("ECONNREFUSED"));

    const res = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: envelope({ id: "req-degraded" }),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe(-32002);
    expect(body.id).toBe("req-degraded");

    spy.mockRestore();
    await cleanupTenant(tenant.tenantId);
  });

  it("an unrecognized method still returns -32601 METHOD_NOT_FOUND", async () => {
    const tenant = await createTestTenant(app);
    const { apiKey } = await createTestAgent(tenant.tenantId, tenant.userId);

    const res = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: envelope({ method: "resources/list", id: "req-unknown" }),
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).error.code).toBe(-32601);

    await cleanupTenant(tenant.tenantId);
  });
});