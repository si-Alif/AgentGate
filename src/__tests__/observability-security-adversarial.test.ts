import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { WebSocket as WsClient } from "ws";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import { createApp } from "../app.js";
import * as originValidator from "../mcp/http/origin-validator.js";
import { rateLimiterRedis } from "../lib/rate-limiter.js";
import { WS_CLOSE_CODE } from "../observability/ws-protocol.js";
import { resetAllConnectionsForTest, getActiveConnectionCount } from "../observability/ws-connection-tracker.js";
import { createTestTenant, createTestAgent, cleanupTenant } from "./helpers/test-tenant.factory.js";
import { executeTool } from "../lib/execute-tool.js";
import { encryptConfig } from "../lib/encryption.js";
import { prisma } from "../lib/prisma.js";
import { createAuditWorker } from "../workers/audit.worker.js";

function connectAndCollect(url: string, headers?: Record<string, string>) {
  const ws = new WsClient(url, headers ? { headers } : undefined);
  const messages: any[] = [];
  ws.on("message", (d) => messages.push(JSON.parse(d.toString())));
  const closed = new Promise<{ code: number }>((resolve) => ws.once("close", (code) => resolve({ code })));
  return { ws, messages, closed };
}
async function waitForMessage(ws: WsClient): Promise<any> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), 3000);
    ws.once("message", (d) => { clearTimeout(t); resolve(JSON.parse(d.toString())); });
  });
}
async function mintTicketFor(app: any, accessToken: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/observability/ticket", headers: { Authorization: `Bearer ${accessToken}` } });
  return JSON.parse(res.body).ticket;
}
async function createSsrfBlockedTool(tenantId: string, name: string) {
  const ciphertext = encryptConfig(JSON.stringify({ handlerType: "http", url: "http://127.0.0.1:1/probe", method: "GET" }), tenantId);
  return prisma.tool.create({
    data: { tenantId, name, handlerType: "http", handlerConfig: ciphertext, inputSchema: { type: "object", properties: {} }, isActive: true },
  });
}

describe("Week 7 Day 6 — Security Adversarial Matrix", () => {
  let app: Awaited<ReturnType<typeof createApp>>;
  let port: number;

  beforeAll(async () => {
    app = await createApp();
    await app.ready();
    await app.listen({ port: 0, host: "127.0.0.1" });
    port = (app.server.address() as AddressInfo).port;
  });
  afterAll(async () => { await app.close(); });
  beforeEach(async () => { resetAllConnectionsForTest(); await rateLimiterRedis.flushdb(); });

  describe("Cross-Site WebSocket Hijacking (CSWSH) — structurally prevented", () => {
    it("GATE — an allowed Origin with NO ticket still cannot open a stream: Origin allowance alone is never sufficient", async () => {
      const { closed } = connectAndCollect(`ws://127.0.0.1:${port}/observability/stream`, { Origin: "https://dashboard.agentgate.example" });
      expect((await closed).code).toBe(WS_CLOSE_CODE.TICKET_INVALID);
    });

    it("GATE — a stolen, valid ticket presented from a DISALLOWED Origin is rejected, AND the ticket is never consumed (Origin runs before GETDEL)", async () => {
      const spy = vi.spyOn(originValidator, "isOriginAllowed").mockReturnValue(false);
      const tenant = await createTestTenant(app);
      const ticket = await mintTicketFor(app, tenant.accessToken);

      const attacker = connectAndCollect(`ws://127.0.0.1:${port}/observability/stream?ticket=${ticket}`, { Origin: "https://evil.example" });
      expect((await attacker.closed).code).toBe(WS_CLOSE_CODE.ORIGIN_NOT_ALLOWED);
      spy.mockRestore();

      // The legitimate owner can still use the SAME ticket — proves
      // the attacker's attempt never redeemed it.
      const legit = connectAndCollect(`ws://127.0.0.1:${port}/observability/stream?ticket=${ticket}`);
      const frame = await waitForMessage(legit.ws);
      expect(frame.type).toBe("connected");
      legit.ws.close();
      await cleanupTenant(tenant.tenantId);
    });

    it("a literal Origin: null (opaque/sandboxed origin) is rejected once a non-empty allow-list is in effect", async () => {
      const spy = vi.spyOn(originValidator, "isOriginAllowed").mockImplementation(
        (origin) => origin !== undefined && origin !== "null" && ["https://good.example"].includes(origin)
      );
      const { closed } = connectAndCollect(`ws://127.0.0.1:${port}/observability/stream?ticket=whatever`, { Origin: "null" });
      expect((await closed).code).toBe(WS_CLOSE_CODE.ORIGIN_NOT_ALLOWED);
      spy.mockRestore();
    });
  });

  describe("Query-string injection — tenant/user scope is derived SOLELY from the redeemed ticket (Finding F9)", () => {
    it("GATE — an injected ?tenantId=<victim> has ZERO effect; the connection is scoped to the ticket's real tenant", async () => {
      const tenant = await createTestTenant(app);
      const victim = await createTestTenant(app);
      const ticket = await mintTicketFor(app, tenant.accessToken);

      const { ws } = connectAndCollect(`ws://127.0.0.1:${port}/observability/stream?ticket=${ticket}&tenantId=${victim.tenantId}`);
      const frame = await waitForMessage(ws);
      expect(frame.tenantId).toBe(tenant.tenantId);

      ws.close();
      await cleanupTenant(tenant.tenantId);
      await cleanupTenant(victim.tenantId);
    });

    it("an injected ?userId=<other> has zero effect on the per-user connection-ceiling accounting", async () => {
      const tenant = await createTestTenant(app);
      const ticket = await mintTicketFor(app, tenant.accessToken);
      const { ws } = connectAndCollect(`ws://127.0.0.1:${port}/observability/stream?ticket=${ticket}&userId=${crypto.randomUUID()}`);
      await waitForMessage(ws);
      expect(getActiveConnectionCount(tenant.userId)).toBe(1);
      ws.close();
      await cleanupTenant(tenant.tenantId);
    });
  });

  describe("Live event redaction boundary — no raw tool input/output ever reaches the wire", () => {
    it("GATE — a real tool call with a secret-shaped argument never leaks it into the live event frame", async () => {
      const worker = createAuditWorker();
      const tenant = await createTestTenant(app);
      const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
      const tool = await createSsrfBlockedTool(tenant.tenantId, `secret-leak-probe-${Date.now()}`);

      const ticket = await mintTicketFor(app, tenant.accessToken);
      const { ws } = connectAndCollect(`ws://127.0.0.1:${port}/observability/stream?ticket=${ticket}`);
      await waitForMessage(ws);

      const eventPromise = waitForMessage(ws);
      await executeTool(tool.id, tenant.tenantId, agent.id, { apiKey: "sk_live_shouldneverleak_000" }, new AbortController().signal);
      const eventFrame = await eventPromise;

      expect(JSON.stringify(eventFrame)).not.toContain("sk_live_shouldneverleak_000");
      expect(eventFrame).not.toHaveProperty("inputPreview");
      expect(eventFrame).not.toHaveProperty("outputPreview");
      expect(eventFrame).not.toHaveProperty("rawPayload");

      ws.close();
      await worker.close();
      await cleanupTenant(tenant.tenantId);
    }, 15_000);
  });
});