import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createApp } from "../app.js";
import { permissionService } from "../services/permission.service.js";
import { toolService } from "../services/tool.service.js";
import { createTestTenant, createTestAgent, createTestTool, cleanupTenant } from "./helpers/test-tenant.factory.js";
import type { FastifyInstance } from "fastify";

/**
 * F6 — tools/list (Day 3's listActiveGrantsForAgent) and tools/call
 * (Week 3's checkPermission/findGrantWithContext) are two
 * INDEPENDENTLY WRITTEN queries encoding the same four-axis freshness
 * rule. This is the first test to prove, directly, that they can never
 * disagree — not by code review, by observed behavior through the real
 * route on both sides at once.
 */
describe("Day 6 — Cross-Endpoint Consistency (tools/list vs. tools/call authorization)", () => {

  let app: FastifyInstance;

  beforeAll(async () => {
    app = await createApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("GATE — every tool tools/list shows is invocable; every tool NOT shown is denied, for the exact same agent", async () => {
    const tenant = await createTestTenant(app);
    const { agent, apiKey } = await createTestAgent(tenant.tenantId, tenant.userId);

    const granted = await createTestTool(tenant.tenantId, { name: `xe-granted-${Date.now()}` } as any);
    const ungranted = await createTestTool(tenant.tenantId, { name: `xe-ungranted-${Date.now()}` } as any);
    const deactivated = await createTestTool(tenant.tenantId, { name: `xe-deactivated-${Date.now()}` } as any);

    await permissionService.assignPermission(tenant.tenantId, { agentId: agent.id, toolId: granted.id });
    await permissionService.assignPermission(tenant.tenantId, { agentId: agent.id, toolId: deactivated.id });
    await toolService.deactivateTool(deactivated.id, tenant.tenantId); // grant exists, tool now inactive

    const listRes = await app.inject({
      method: "POST", url: "/mcp",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { jsonrpc: "2.0", id: "xe-list", method: "tools/list", _meta: { protocolVersion: "2026-07-28" } },
    });
    const listedNames = new Set(JSON.parse(listRes.body).result.tools.map((t: any) => t.name));

    expect(listedNames.has(granted.name)).toBe(true);
    expect(listedNames.has(ungranted.name)).toBe(false);
    expect(listedNames.has(deactivated.name)).toBe(false); // active grant, inactive tool — correctly hidden

    async function call(name: string, id: string) {
      const res = await app.inject({
        method: "POST", url: "/mcp",
        headers: { authorization: `Bearer ${apiKey}` },
        payload: { jsonrpc: "2.0", id, method: "tools/call", params: { name }, _meta: { protocolVersion: "2026-07-28" } },
      });
      return JSON.parse(res.body);
    }

    // Listed -> invocable (permission-wise; execution itself may still
    // fail for unrelated reasons, but must NOT be a -32000/-32003 denial).
    const grantedResult = await call(granted.name, "xe-call-granted");
    expect(grantedResult.error?.code).not.toBe(-32000);
    expect(grantedResult.error?.code).not.toBe(-32003);

    // Never listed, never granted -> denied.
    const ungrantedResult = await call(ungranted.name, "xe-call-ungranted");
    expect(ungrantedResult.error.code).toBe(-32000);

    // Hidden from the list because the TOOL is inactive -> tools/call
    // agrees with the SAME reason class, not a different one.
    const deactivatedResult = await call(deactivated.name, "xe-call-deactivated");
    expect(deactivatedResult.error.code).toBe(-32003);

    await cleanupTenant(tenant.tenantId);
  });
});