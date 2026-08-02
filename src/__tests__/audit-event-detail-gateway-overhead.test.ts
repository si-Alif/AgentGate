import type { FastifyInstance } from "fastify";
import { createApp } from "../app.js";
import { describe, it, expect  , beforeAll , afterAll} from "vitest";
import { executeTool } from "../lib/execute-tool.js";
import { toolService } from "../services/tool.service.js";
import { createAuditWorker } from "../workers/audit.worker.js";
import { getAuditEventDetail } from "../repositories/audit-event-read.repository.js";
import { prisma } from "../lib/prisma.js";
import { createTestTenant, createTestAgent, cleanupTenant } from "./helpers/test-tenant.factory.js";

async function waitFor(assertion: () => Promise<void>, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (true) {
    try { await assertion(); return; } catch (err) {
      if (Date.now() - start > timeoutMs) throw err;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

describe("getAuditEventDetail — gatewayOverheadMs surfacing (Day 5, Finding F4)", () => {

  let app: FastifyInstance;

  beforeAll(async () => {
    app = await createApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("GATE — gatewayOverheadMs, present in event.payload, IS reachable via the detail read path", async () => {
    const tenant = await createTestTenant(app);
    const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
    const worker = createAuditWorker();
    const tool = await toolService.createTool(tenant.tenantId, {
      name: `detail-gw-probe-${Date.now()}`,
      handlerType: "web_fetch",
      handlerConfig: { handlerType: "web_fetch", url: "http://instant-fail.test/probe" },
      inputSchema: {},
    });

    await executeTool(tool.id, tenant.tenantId, agent.id, {}, new AbortController().signal, undefined, 123);

    const rows = await prisma.auditEvent.findMany({ where: { tenantId: tenant.tenantId, toolId: tool.id } });
    const eventId = rows[0]?.id;

    await waitFor(async () => {
      const detail = await getAuditEventDetail(tenant.tenantId, eventId as string);
      expect(detail).not.toBeNull();
      expect((detail as any).gatewayOverheadMs).toBe(123);
    });

    await worker.close();
    await cleanupTenant(tenant.tenantId);
  });

  it("omits gatewayOverheadMs from the detail response entirely when it was never captured (no stray key, no null placeholder)", async () => {
    const worker = createAuditWorker();
    const tenant = await createTestTenant(app);
    const { agent } = await createTestAgent(tenant.tenantId, tenant.tenantId);
    const tool = await toolService.createTool(tenant.tenantId, {
      name: `detail-no-gw-probe-${Date.now()}`,
      handlerType: "web_fetch",
      handlerConfig: { handlerType: "web_fetch", url: "http://localhost.localdomain:1/probe" },
      inputSchema: {},
    });

    await executeTool(tool.id, tenant.tenantId, agent.id, {}, new AbortController().signal); // no gatewayOverheadMs supplied

    const rows = await prisma.auditEvent.findMany({ where: { tenantId: tenant.tenantId, toolId: tool.id } });
    const eventId = rows[0]?.id;

    await waitFor(async () => {
      const detail = await getAuditEventDetail(tenant.tenantId, eventId as string);
      expect(detail).not.toBeNull();
      expect("gatewayOverheadMs" in (detail as object)).toBe(false);
    });

    await worker.close();
    await cleanupTenant(tenant.tenantId);
  });
});