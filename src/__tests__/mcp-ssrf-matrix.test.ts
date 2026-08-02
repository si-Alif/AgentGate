import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createApp } from "../app.js";
import { prisma } from "../lib/prisma.js";
import { encryptConfig } from "../lib/encryption.js";
import { permissionService } from "../services/permission.service.js";
import { createTestTenant, createTestAgent, cleanupTenant } from "./helpers/test-tenant.factory.js";
import type { FastifyInstance } from "fastify";
import { createAuditWorker } from "../workers/audit.worker.js";

/**
 * Both fixtures below deliberately bypass toolService.createTool() —
 * Week 2's own Layer 1 SSRF pre-filter would reject a literal loopback
 * URL at CREATION time. A direct Prisma insert (identical technique to
 * Week 4 Day 6's and Week 6 Day 4's own adversarial fixtures) is the
 * only way to get a genuinely unmocked executeTool() call through the
 * real /mcp route against a target Layer 2 (Week 4) is guaranteed to
 * block — turning a known test-environment limitation into a real,
 * strict assertion. See roadmap_w6_d6.md Finding F7 / Decision 6.8.
 */
async function createSsrfBlockedTool(tenantId: string, handlerType: "http" | "web_fetch", name: string) {
  const handlerConfig =
    handlerType === "http"
      ? { handlerType: "http" as const, url: "http://127.0.0.1:1/probe", method: "GET" as const }
      : { handlerType: "web_fetch" as const, url: "http://127.0.0.1:1/probe" };

  const ciphertext = encryptConfig(JSON.stringify(handlerConfig), tenantId);
  return prisma.tool.create({
    data: {
      tenantId, name, handlerType,
      handlerConfig: ciphertext,
      inputSchema: { type: "object", properties: {} },
      isActive: true,
    },
  });
}

describe("Day 6 — SSRF Matrix Across Handler Types (extends Day 4's HTTP-only proof)", () => {

  let app: FastifyInstance;
  let worker : any ;


  beforeAll(async () => {
    app = await createApp();
    await app.ready();
    worker = createAuditWorker();
  });

  afterAll(async () => {
    if (worker) await worker.close();
    await app.close();

  });

  function envelope(id: string, name: string) {
    return { jsonrpc: "2.0", id, method: "tools/call", params: { name }, _meta: { protocolVersion: "2026-07-28" } };
  }

  it("GATE — HTTP handler: a real, unmocked executeTool() call is blocked by SSRF Layer 2 -> -32008 (re-confirms Day 4)", async () => {
    const tenant = await createTestTenant(app);
    const { agent, apiKey } = await createTestAgent(tenant.tenantId, tenant.userId);
    const tool = await createSsrfBlockedTool(tenant.tenantId, "http", `ssrf-http-${Date.now()}`);
    await permissionService.assignPermission(tenant.tenantId, { agentId: agent.id, toolId: tool.id });

    const res = await app.inject({
      method: "POST", url: "/mcp",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: envelope("ssrf-http", tool.name),
    });
    expect(JSON.parse(res.body).error.code).toBe(-32008);

    await cleanupTenant(tenant.tenantId);
  });

  it("GATE (Decision 6.8, F7) — WebFetch handler: a real, unmocked executeTool() call is blocked by SSRF Layer 2 -> -32008", async () => {
    const tenant = await createTestTenant(app);
    const { agent, apiKey } = await createTestAgent(tenant.tenantId, tenant.userId);
    const tool = await createSsrfBlockedTool(tenant.tenantId, "web_fetch", `ssrf-webfetch-${Date.now()}`);
    await permissionService.assignPermission(tenant.tenantId, { agentId: agent.id, toolId: tool.id });

    const res = await app.inject({
      method: "POST", url: "/mcp",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: envelope("ssrf-webfetch", tool.name),
    });
    expect(JSON.parse(res.body).error.code).toBe(-32008);

    await cleanupTenant(tenant.tenantId);
  });

  it("both SSRF-blocked calls above produce a queryable TOOL_INVOCATION audit row with errorCode SSRF_BLOCKED", async () => {
    const tenant = await createTestTenant(app);
    const { agent, apiKey } = await createTestAgent(tenant.tenantId, tenant.userId);
    const tool = await createSsrfBlockedTool(tenant.tenantId, "http", `ssrf-audit-${Date.now()}`);
    await permissionService.assignPermission(tenant.tenantId, { agentId: agent.id, toolId: tool.id });

    await app.inject({
      method: "POST", url: "/mcp",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: envelope("ssrf-audit", tool.name),
    });

    await new Promise((r) => setTimeout(r, 500));
    const row = await prisma.toolExecution.findFirst({ where: { tenantId: tenant.tenantId, toolId: tool.id } });
    expect(row).not.toBeNull();
    expect(row!.errorCode).toBe("SSRF_BLOCKED");

    await cleanupTenant(tenant.tenantId);
  });
});