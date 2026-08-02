import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createApp } from "../app.js";
import { permissionService } from "../services/permission.service.js";
import {
  createTestTenant, createTestAgent, createTestTool, cleanupTenant,
} from "./helpers/test-tenant.factory.js";
import type { FastifyInstance } from "fastify";

describe("Day 6 — Tenant Isolation Matrix", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await createApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });


  function envelope(method: string, params: unknown, id: string | number = "iso") {
    return { jsonrpc: "2.0", id, method, params, _meta: { protocolVersion: "2026-07-28" } };
  }

  it("GATE — Tenant A cannot discover Tenant B's tools via tools/list", async () => {
    const tenantA = await createTestTenant(app);
    const tenantB = await createTestTenant(app);
    const { agent: agentA, apiKey: apiKeyA } = await createTestAgent(tenantA.tenantId, tenantA.userId);
    const { agent: agentB } = await createTestAgent(tenantB.tenantId, tenantB.userId);
    const toolB = await createTestTool(tenantB.tenantId);
    await permissionService.assignPermission(tenantB.tenantId, { agentId: agentB.id, toolId: toolB.id });

    const res = await app.inject({
      method: "POST", url: "/mcp",
      headers: { authorization: `Bearer ${apiKeyA}` },
      payload: envelope("tools/list", {}),
    });
    const body = JSON.parse(res.body);
    expect(body.result.tools.some((t: any) => t.name === toolB.name)).toBe(false);

    await cleanupTenant(tenantA.tenantId);
    await cleanupTenant(tenantB.tenantId);
  });

  it("GATE (Decision 6.11) — Tenant A guessing Tenant B's exact tool name via tools/call gets -32003 TOOL_NOT_FOUND, NEVER -32000 PERMISSION_DENIED", async () => {
    const tenantA = await createTestTenant(app);
    const tenantB = await createTestTenant(app  );
    const { apiKey: apiKeyA } = await createTestAgent(tenantA.tenantId, tenantA.userId);
    const { agent: agentB } = await createTestAgent(tenantB.tenantId, tenantB.userId);
    const toolB = await createTestTool(tenantB.tenantId);
    await permissionService.assignPermission(tenantB.tenantId, { agentId: agentB.id, toolId: toolB.id });

    const res = await app.inject({
      method: "POST", url: "/mcp",
      headers: { authorization: `Bearer ${apiKeyA}` },
      payload: envelope("tools/call", { name: toolB.name }),
    });
    const body = JSON.parse(res.body);
    // MUST be "not found", never "denied" — a -32000 here would leak
    // that a tool by this name exists somewhere, just not for you.
    expect(body.error.code).toBe(-32003);
    expect(body.error.code).not.toBe(-32000);

    await cleanupTenant(tenantA.tenantId);
    await cleanupTenant(tenantB.tenantId);
  });

  it("GATE — Tenant A's audit log contains zero events attributable to Tenant B, even after cross-tenant guessing attempts", async () => {
    const tenantA = await createTestTenant(app);
    const tenantB = await createTestTenant(app);
    const { apiKey: apiKeyA } = await createTestAgent(tenantA.tenantId, tenantA.userId);
    const { agent: agentB } = await createTestAgent(tenantB.tenantId, tenantB.userId);
    const toolB = await createTestTool(tenantB.tenantId);
    await permissionService.assignPermission(tenantB.tenantId, { agentId: agentB.id, toolId: toolB.id });

    await app.inject({
      method: "POST", url: "/mcp",
      headers: { authorization: `Bearer ${apiKeyA}` },
      payload: envelope("tools/call", { name: toolB.name }),
    });

    const { prisma } = await import("../lib/prisma.js");
    const leaked = await prisma.auditEvent.findMany({ where: { tenantId: tenantA.tenantId, toolId: toolB.id } });
    expect(leaked).toHaveLength(0);

    await cleanupTenant(tenantA.tenantId);
    await cleanupTenant(tenantB.tenantId);
  });
});