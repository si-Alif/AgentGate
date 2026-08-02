import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createApp } from "../app.js";
import { createAuditWorker } from "../workers/audit.worker.js";
import { prisma } from "../lib/prisma.js";
import { encryptConfig } from "../lib/encryption.js";
import { permissionService } from "../services/permission.service.js";
import { createTestTenant, createTestAgent, createTestTool, cleanupTenant } from "./helpers/test-tenant.factory.js";
import type { FastifyInstance } from "fastify";

async function waitFor(assertion: () => Promise<void>, timeoutMs = 5000, intervalMs = 150): Promise<void> {
  const start = Date.now();
  while (true) {
    try {
      await assertion();
      return;
    } catch (err) {
      if (Date.now() - start > timeoutMs) throw err;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}

/**
 * A deliberately SSRF-Layer-2-blocked target (loopback). Rejected via
 * the literal-IP fast path in assertSafeUrlHost() — NO DNS lookup, NO
 * socket connection attempt, fails synchronously in low single-digit
 * milliseconds regardless of the test environment's real network
 * access. This is the fix for the actual bug: createTestTool()'s
 * default handler config points at a REAL external URL
 * (https://example.com), and this test needs 60+ SEQUENTIAL, AWAITED
 * calls that all reach executeTool() (they're all below the rate
 * limit until the very last one) — 60+ real outbound HTTP round-trips
 * is what actually blew the 20s budget, not a timing race.
 *
 * Created via a direct Prisma insert, bypassing toolService.createTool()
 * — Week 2's Layer 1 pre-filter rejects a literal loopback URL at
 * creation time, same reason Day 4's own SSRF-blocked-tool fixtures
 * and the corrected execute-tool-gateway-overhead.test.ts both do this.
 */
async function createSsrfBlockedTool(tenantId: string, name: string) {
  const ciphertext = encryptConfig(
    JSON.stringify({ handlerType: "http", url: "http://127.0.0.1:1/probe", method: "GET" }),
    tenantId
  );
  return prisma.tool.create({
    data: {
      tenantId,
      name,
      handlerType: "http",
      handlerConfig: ciphertext,
      inputSchema: { type: "object", properties: {} },
      isActive: true,
    },
  });
}

describe("Day 6 — Full Pipeline Ordering, Observed End-to-End", () => {
  let app: FastifyInstance;
  let worker: ReturnType<typeof createAuditWorker>;

  beforeAll(async () => {
    app = await createApp();
    await app.ready();
    worker = createAuditWorker();
  });

  afterAll(async () => {
    await worker.close();
    await app.close();
  });

  function envelope(id: string, name: string, args: unknown = {}) {
    return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args }, _meta: { protocolVersion: "2026-07-28" } };
  }

  it("GATE — a permission denial leaves no TOOL_INVOCATION row (executeTool never ran)", async () => {
    const tenant = await createTestTenant(app);
    const { apiKey } = await createTestAgent(tenant.tenantId, tenant.userId);
    const tool = await createTestTool(tenant.tenantId); // fine here — never reaches executeTool()

    const res = await app.inject({
      method: "POST", url: "/mcp",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: envelope("order-perm", tool.name),
    });
    expect(JSON.parse(res.body).error.code).toBe(-32000);

    const execRow = await prisma.toolExecution.findFirst({ where: { tenantId: tenant.tenantId, toolId: tool.id } });
    expect(execRow).toBeNull();

    await waitFor(async () => {
      const permRow = await prisma.auditEvent.findFirst({
        where: { tenantId: tenant.tenantId, toolId: tool.id, eventType: "PERMISSION_DENIED" },
      });
      expect(permRow).not.toBeNull();
    });

    await cleanupTenant(tenant.tenantId);
  });

  it("GATE — an AJV rejection (permission GRANTED) leaves no TOOL_INVOCATION row and no RATE_LIMITED row", async () => {
    const tenant = await createTestTenant(app);
    const { agent, apiKey } = await createTestAgent(tenant.tenantId, tenant.userId);
    const tool = await createTestTool(tenant.tenantId, {
      inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
    } as any); // fine here too — never reaches executeTool()
    await permissionService.assignPermission(tenant.tenantId, { agentId: agent.id, toolId: tool.id });

    const res = await app.inject({
      method: "POST", url: "/mcp",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: envelope("order-ajv", tool.name, {}),
    });
    expect(JSON.parse(res.body).error.code).toBe(-32602);

    await new Promise((r) => setTimeout(r, 300));
    const execRow = await prisma.toolExecution.findFirst({ where: { tenantId: tenant.tenantId, toolId: tool.id } });
    expect(execRow).toBeNull();
    const rlRow = await prisma.auditEvent.findFirst({
      where: { tenantId: tenant.tenantId, toolId: tool.id, eventType: "RATE_LIMITED" },
    });
    expect(rlRow).toBeNull();

    await cleanupTenant(tenant.tenantId);
  });

  it("GATE — a rate-limit denial (permission granted, AJV passed) leaves no TOOL_INVOCATION row, but a RATE_LIMITED row exists", async () => {
    const tenant = await createTestTenant(app);
    const { agent, apiKey } = await createTestAgent(tenant.tenantId, tenant.userId);
    // FIX: SSRF-blocked target, not the real-network default. Every
    // call below the limit still reaches executeTool() — it just
    // fails fast and locally instead of hitting the real network 60+
    // times in a row.
    const tool = await createSsrfBlockedTool(tenant.tenantId, `pipeline-order-rl-${Date.now()}`);
    await permissionService.assignPermission(tenant.tenantId, { agentId: agent.id, toolId: tool.id });

    const { env } = await import("../config/env.js");
    const limit = env.AGENTGATE_MCP_TOOL_CALL_RATE_LIMIT;
    for (let i = 0; i < limit; i++) {
      await app.inject({
        method: "POST", url: "/mcp",
        headers: { authorization: `Bearer ${apiKey}` },
        payload: envelope(`order-rl-${i}`, tool.name),
      });
    }
    const overLimit = await app.inject({
      method: "POST", url: "/mcp",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: envelope("order-rl-final", tool.name),
    });
    expect(JSON.parse(overLimit.body).error.code).toBe(-32001);

    await waitFor(async () => {
      const rlRow = await prisma.auditEvent.findFirst({
        where: { tenantId: tenant.tenantId, toolId: tool.id, eventType: "RATE_LIMITED" },
      });
      expect(rlRow).not.toBeNull();
    });

    await cleanupTenant(tenant.tenantId);
  }, 15_000); // generous margin now, not a load-bearing requirement — the loop itself should finish in well under a second
});