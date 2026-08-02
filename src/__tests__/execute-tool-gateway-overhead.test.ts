// src/__tests__/execute-tool-gateway-overhead.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { executeTool } from "../lib/execute-tool.js";
import { createAuditWorker } from "../workers/audit.worker.js";
import { encryptConfig } from "../lib/encryption.js";
import { prisma } from "../lib/prisma.js";
import { DEFAULT_TIMEOUT_MS } from "../handlers/types.js";
import { createTestTenant, createTestAgent, cleanupTenant } from "./helpers/test-tenant.factory.js";
import type { FastifyInstance } from "fastify";
import { createApp } from "../app.js";
/**
 * A deliberately SSRF-blocked target (loopback), for the SAME reason
 * Day 4's own mcp-route-tools-call.test.ts used one: it fails FAST and
 * DETERMINISTICALLY, with no real network I/O and no mocking needed —
 * this test only cares that executeTool() actually ran and its own
 * internal audit() closure fired, not whether the call succeeded.
 *
 * Created via a DIRECT Prisma insert, NOT toolService.createTool() —
 * Week 2's own Layer 1 pre-filter rejects a literal loopback URL at
 * creation time (the exact reason Day 4's own SSRF-blocked-tool test
 * bypasses the service layer). encryptConfig() is called directly to
 * produce valid ciphertext, mirroring Day 4's own fixture construction.
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

/**
 * enqueueAuditEvent() is fire-and-forget — the job is added to BullMQ
 * but never awaited, and nothing lands in Postgres until a worker
 * actually processes it. This helper polls until the row appears (or
 * times out) — the fix for the original bug: it must actually be
 * CALLED, not just defined.
 *
 * executeTool()'s own return value (ExecutionResult) never exposes the
 * audit event's generated id, so the row is located by (tenantId,
 * toolId, eventType) — sufficient uniqueness given each test below uses
 * its own dedicated, freshly-created tool.
 */
async function waitForAuditRow(
  tenantId: string,
  toolId: string,
  timeoutMs = 5000
): Promise<{ payload: unknown }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const rows = await prisma.auditEvent.findMany({
      where: { tenantId, toolId, eventType: "TOOL_INVOCATION" },
      orderBy: { createdAt: "desc" },
      take: 1,
    });
    if (rows.length > 0) return rows[0]!;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`audit row for tool ${toolId} never appeared within ${timeoutMs}ms`);
}

describe("executeTool — gatewayOverheadMs pass-through (Day 5, Finding F1 fix)", () => {
  let worker: ReturnType<typeof createAuditWorker>;
  let app : FastifyInstance;

  beforeAll(async () => {
    app = await createApp();
    await app.ready();
    worker = createAuditWorker(); // REQUIRED — without this, nothing ever consumes the queue
  });

  afterAll(async () => {
    await worker.close();
    await app.close();
  });

  it("GATE — when supplied, gatewayOverheadMs lands in the SAME persisted TOOL_INVOCATION row, not a later update", async () => {
    const tenant = await createTestTenant(app);
    const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
    const tool = await createSsrfBlockedTool(tenant.tenantId, `gw-overhead-probe-${Date.now()}`);

    // Matches executeTool()'s real, shipped signature exactly:
    // (toolId, tenantId, agentId, inputParams, externalSignal?, timeoutMs = DEFAULT_TIMEOUT_MS, gatewayOverheadMs?)
    // DEFAULT_TIMEOUT_MS is passed EXPLICITLY here (not a bare
    // `undefined`) to stay consistent with how tools-call-handler.ts
    // itself calls executeTool() as of this same day's patch — no
    // ambiguity about which positional slot is which.
    await executeTool(
      tool.id,
      tenant.tenantId,
      agent.id,
      {},
      new AbortController().signal,
      DEFAULT_TIMEOUT_MS,
      42 // gatewayOverheadMs
    );

    const row = await waitForAuditRow(tenant.tenantId, tool.id);
    const payload = row.payload as Record<string, unknown>;
    expect(payload.gatewayOverheadMs).toBe(42);

    await cleanupTenant(tenant.tenantId);
  });

  it("omits gatewayOverheadMs entirely when the caller doesn't supply one (backward compatible with every pre-Day-5 call site)", async () => {
    const tenant = await createTestTenant(app);
    const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
    const tool = await createSsrfBlockedTool(tenant.tenantId, `no-gw-overhead-probe-${Date.now()}`);

    // The Week 4/5 call shape, unchanged — no 7th argument at all.
    await executeTool(tool.id, tenant.tenantId, agent.id, {}, new AbortController().signal);

    const row = await waitForAuditRow(tenant.tenantId , tool.id);
    const payload = row.payload as Record<string, unknown>;
    expect(payload.gatewayOverheadMs).toBeUndefined();
    expect("gatewayOverheadMs" in payload).toBe(false);

    await cleanupTenant(tenant.tenantId);
  });
});