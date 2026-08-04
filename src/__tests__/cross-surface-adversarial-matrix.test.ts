import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WebSocket as WsClient } from "ws";
import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { startFullSystem, stopFullSystem } from "./helpers/system-harness.js";
import type { SystemHarness } from "./helpers/system-harness.js";
import {
  createTestTenant,
  createTestAgent,
  createSsrfBlockedTool,
  cleanupTenant,
} from "./helpers/test-tenant.factory.js";
import { permissionService } from "../services/permission.service.js";

function mcpEnvelope(method: string, params: unknown, id: string | number) {
  return { jsonrpc: "2.0", id, method, params, _meta: { protocolVersion: "2026-07-28" } };
}
async function mcpCall(app: FastifyInstance, apiKey: string, method: string, params: unknown, id: string | number) {
  const res = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: { authorization: `Bearer ${apiKey}` },
    payload: mcpEnvelope(method, params, id),
  });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}
function connectAndCollect(url: string) {
  const ws = new WsClient(url);
  const messages: any[] = [];
  ws.on("message", (d) => messages.push(JSON.parse(d.toString())));
  const closed = new Promise<{ code: number }>((resolve) => ws.once("close", (c) => resolve({ code: c })));
  return { ws, messages, closed };
}
async function waitForMessage(ws: WsClient, predicate?: (m: any) => boolean, timeoutMs = 4000): Promise<any> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timed out waiting for a matching WS message")), timeoutMs);
    const handler = (data: Buffer) => {
      const parsed = JSON.parse(data.toString());
      if (!predicate || predicate(parsed)) {
        clearTimeout(t);
        ws.off("message", handler);
        resolve(parsed);
      }
    };
    ws.on("message", handler);
  });
}
async function mintTicket(app: FastifyInstance, accessToken: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/observability/ticket",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return JSON.parse(res.body).ticket;
}

/**
 * Week 8, Day 2 — The Cross-Surface Adversarial Matrix.
 *
 * ONE attacker persona (Tenant A's real JWT + real agent API key)
 * pivoting against Tenant B's data, across all three authenticated
 * surfaces (REST/MCP/WS) — first SEQUENTIALLY, one door at a time,
 * then a SECOND time, genuinely CONCURRENTLY via Promise.all
 * (Decision 8.45 / Finding F6). Extends, does not duplicate, Week 8
 * Day 1's own Flow 8, which proved each surface's isolation
 * independently; today proves the COMBINATION.
 */
describe("Week 8, Day 2 — Cross-Surface Adversarial Matrix (one attacker, every door)", () => {
  let harness: SystemHarness;
  let tenantA: { tenantId: string; userId: string; accessToken: string };
  let tenantB: { tenantId: string; userId: string; accessToken: string };
  let agentA: { id: string };
  let apiKeyA: string;
  let agentB: { id: string };
  let apiKeyB: string;
  let toolB: { id: string; name: string };
  let wsA: ReturnType<typeof connectAndCollect>;

  beforeAll(async () => {
    harness = await startFullSystem();

    tenantA = await createTestTenant(harness.app);
    const createdA = await createTestAgent(tenantA.tenantId, tenantA.userId);
    agentA = createdA.agent;
    apiKeyA = createdA.apiKey;

    tenantB = await createTestTenant(harness.app);
    const createdB = await createTestAgent(tenantB.tenantId, tenantB.userId);
    agentB = createdB.agent;
    apiKeyB = createdB.apiKey;

    const toolBRow = await createSsrfBlockedTool(tenantB.tenantId, `matrix-toolB-${crypto.randomUUID()}`);
    toolB = { id: toolBRow.id, name: toolBRow.name };
    await permissionService.assignPermission(tenantB.tenantId, { agentId: agentB.id, toolId: toolB.id });

    const ticket = await mintTicket(harness.app, tenantA.accessToken);
    wsA = connectAndCollect(`ws://127.0.0.1:${harness.port}/observability/stream?ticket=${ticket}`);
    await waitForMessage(wsA.ws, (m) => m.type === "connected");
  }, 30_000);

  afterAll(async () => {
    wsA.ws.close();
    await cleanupTenant(tenantA.tenantId).catch(() => { });
    await cleanupTenant(tenantB.tenantId).catch(() => { });
    await stopFullSystem(harness);
  }, 20_000);

  describe("Sequential pivot — one attacker session, one door at a time", () => {
    it("PIVOT 1/3 — REST /api/*: Tenant A's JWT cannot read Tenant B's tools or list Tenant B's real permission grants", async () => {
      const getToolB = await harness.app.inject({
        method: "GET",
        url: `/api/tools/${toolB.id}`,
        headers: { Authorization: `Bearer ${tenantA.accessToken}` },
      });
      expect(getToolB.statusCode).toBe(404);

      const listPermsB = await harness.app.inject({
        method: "GET",
        url: `/api/agents/${agentB.id}/permissions`,
        headers: { Authorization: `Bearer ${tenantA.accessToken}` },
      });

      // FIX: The handler properly verifies if the parent agent exists under
      // the caller's tenant first. Since it doesn't, it securely returns 404.
      expect(listPermsB.statusCode).toBe(404);
    });

    it("PIVOT 2/3 — MCP /mcp: Tenant A's agent key cannot discover or invoke Tenant B's tool", async () => {
      const list = await mcpCall(harness.app, apiKeyA, "tools/list", {}, "pivot-mcp-list");
      expect(list.body.result.tools.map((t: any) => t.name)).not.toContain(toolB.name);

      const call = await mcpCall(harness.app, apiKeyA, "tools/call", { name: toolB.name }, "pivot-mcp-call");
      expect(call.body.error?.code).toBe(-32003); // TOOL_NOT_FOUND — tenant-scoped name resolution (Week 6 Decision 6.10)
    });

    it("PIVOT 3/3 — WS /observability/stream: Tenant A's live connection never observes a real Tenant B tool call", async () => {
      await mcpCall(harness.app, apiKeyB, "tools/call", { name: toolB.name }, "pivot-ws-trigger");

      let leaked = false;
      await Promise.race([
        waitForMessage(wsA.ws, (m) => m.type === "event").then(() => {
          leaked = true;
        }),
        new Promise((resolve) => setTimeout(resolve, 500)),
      ]);
      expect(leaked).toBe(false);
    });
  });

  describe("Concurrent pivot — the same three doors, tried simultaneously (Promise.all)", () => {
    it("GATE — REST + MCP + WS pivots fired at the exact same instant never observe or affect Tenant B's data, and never interfere with each other", async () => {
      const restPromise = harness.app.inject({
        method: "GET",
        url: `/api/tools/${toolB.id}`,
        headers: { Authorization: `Bearer ${tenantA.accessToken}` },
      });
      const mcpPromise = mcpCall(harness.app, apiKeyA, "tools/call", { name: toolB.name }, "concurrent-mcp");
      const wsLeakPromise = Promise.race([
        waitForMessage(wsA.ws, (m) => m.type === "event" && m.toolId === toolB.id).then(() => "leaked" as const),
        new Promise<"clean">((resolve) => setTimeout(() => resolve("clean"), 600)),
      ]);
      const triggerPromise = mcpCall(harness.app, apiKeyB, "tools/call", { name: toolB.name }, "concurrent-trigger");

      const [restRes, mcpRes, wsOutcome] = await Promise.all([restPromise, mcpPromise, wsLeakPromise, triggerPromise]);

      expect(restRes.statusCode).toBe(404);
      expect(mcpRes.body.error?.code).toBe(-32003);
      expect(wsOutcome).toBe("clean");
    }, 10_000);
  });

  describe("BONUS — public-auth throttle coexists cleanly with authenticated-surface traffic", () => {
    it("the coarse public-auth throttle namespace never interferes with the MCP/tool-call throttle namespace, even under simultaneous load", async () => {
      const results = await Promise.all([
        mcpCall(harness.app, apiKeyA, "tools/list", {}, "coexist-1"),
        harness.app.inject({
          method: "POST",
          url: "/auth/login",
          payload: { email: "nobody-coexist@example.com", password: "x" },
        }),
      ]);
      expect(results[0].status).toBe(200);
      expect(results[1].statusCode).not.toBe(429); // one login attempt, far under the throttle
    });
  });
});