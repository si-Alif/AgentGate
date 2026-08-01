import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createApp } from "../app.js";
import { prisma } from "../lib/prisma.js";
import { encryptConfig } from "../lib/encryption.js";
import { permissionService } from "../services/permission.service.js";
import { createTestTenant, createTestAgent, createTestTool, cleanupTenant } from "./helpers/test-tenant.factory.js";

describe("POST /mcp — tools/call, real end-to-end", () => {
  let app: Awaited<ReturnType<typeof createApp>>;
  beforeAll(async () => { app = await createApp(); });
  afterAll(async () => { await app.close(); });

  function envelope(params: unknown, id: string | number = "req-1") {
    return { jsonrpc: "2.0", id, method: "tools/call", params, _meta: { protocolVersion: "2026-07-28" } };
  }

  it("CHECKPOINT — a real, unmocked executeTool() call against a hostname that resolves to loopback is blocked by SSRF Layer 2, and the gateway correctly maps it to -32008", async () => {
    // Bypasses toolService.createTool() deliberately — Week 2's own
    // Layer 1 pre-filter would reject a literal loopback target at
    // creation time. Direct Prisma insert mirrors exactly how Week 4's
    // own adversarial handler tests avoided the same problem. The key
    // difference is that this target is hostname-safe at config time,
    // so the request reaches the real DNS/runtime SSRF guard and then
    // fails there with the specific -32008 mapping we care about.
    const tenant = await createTestTenant(app);
    const { agent, apiKey } = await createTestAgent(tenant.tenantId, tenant.userId);
    const ciphertext = encryptConfig(
      JSON.stringify({ handlerType: "http", url: "http://localhost.localdomain:1/probe", method: "GET" }),
      tenant.tenantId
    );
    const tool = await prisma.tool.create({
      data: {
        tenantId: tenant.tenantId, name: "ssrf-probe", handlerType: "http",
        handlerConfig: ciphertext, inputSchema: { type: "object", properties: {} }, isActive: true,
      },
    });
    await permissionService.assignPermission(tenant.tenantId, { agentId: agent.id, toolId: tool.id });

    const res = await app.inject({
      method: "POST", url: "/mcp",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: envelope({ name: "ssrf-probe" }),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe(-32008);

    await cleanupTenant(tenant.tenantId);
  });

  it("Mcp-Name header mismatch is rejected with -32600 before touching the database", async () => {
    const tenant = await createTestTenant(app);
    const { apiKey } = await createTestAgent(tenant.tenantId, tenant.userId);

    const res = await app.inject({
      method: "POST", url: "/mcp",
      headers: { authorization: `Bearer ${apiKey}`, "mcp-name": "wrong-name" },
      payload: envelope({ name: "actual-name" }),
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).error.code).toBe(-32600);
    await cleanupTenant(tenant.tenantId);
  });

  it("a permission denial via the real route returns -32000, with a defined but non-sensitive data payload", async () => {
    const tenant = await createTestTenant(app);
    const { apiKey } = await createTestAgent(tenant.tenantId, tenant.userId);
    const tool = await createTestTool(tenant.tenantId); // no grant

    const res = await app.inject({
      method: "POST", url: "/mcp",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: envelope({ name: tool.name }),
    });

    const body = JSON.parse(res.body);
    expect(body.error.code).toBe(-32000);
    expect(JSON.stringify(body)).not.toMatch(/password|secret|connection/i);
    await cleanupTenant(tenant.tenantId);
  });

  it("malformed arguments against a real permitted tool return -32602 with AJV issues in data", async () => {
    const tenant = await createTestTenant(app);
    const { agent, apiKey } = await createTestAgent(tenant.tenantId, tenant.userId);
    const tool = await createTestTool(tenant.tenantId, {
      inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
    } as any);
    await permissionService.assignPermission(tenant.tenantId, { agentId: agent.id, toolId: tool.id });

    const res = await app.inject({
      method: "POST", url: "/mcp",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: envelope({ name: tool.name, arguments: {} }),
    });

    const body = JSON.parse(res.body);
    expect(body.error.code).toBe(-32602);
    expect(body.error.data.issues).toBeDefined();
    await cleanupTenant(tenant.tenantId);
  });
});