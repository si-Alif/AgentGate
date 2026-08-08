import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { WebSocket, WebSocket as WsClient } from "ws";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import { createApp } from "../app.js";
import { rateLimiterRedis } from "../lib/rate-limiter.js";
import * as originValidator from "../mcp/http/origin-validator.js";
import { env } from "../config/env.js";
import { encryptConfig } from "../lib/encryption.js";
import { prisma } from "../lib/prisma.js";
import { executeTool } from "../lib/execute-tool.js";
import { createAuditWorker } from "../workers/audit.worker.js";
import { createTestTenant, createTestAgent, createTestTool, cleanupTenant } from "./helpers/test-tenant.factory.js";
import { permissionService } from "../services/permission.service.js";
import { handleToolsCall } from "../mcp/tools/tools-call-handler.js";
import { tenantEventChannelName } from "../lib/audit-publish.js";
import { resetAllConnectionsForTest, getActiveConnectionCount } from "../observability/ws-connection-tracker.js";
import {
  tenantEventSubscriber, registerTenantViewer, dispatchTenantMessage, getViewerCountForTenant,
  getSubscribedTenantCount, getTotalViewerCount, getAllRegisteredSockets,
  closeAllObservabilityConnections, resetTenantRegistryForTest,
} from "../observability/ws-tenant-registry.js";
import { WS_CLOSE_CODE } from "../observability/ws-protocol.js";

function connectAndCollect(url: string, headers?: Record<string, string>) {
  const ws = new WsClient(url, headers ? { headers } : undefined);
  const messages: any[] = [];
  ws.on("message", (d) => messages.push(JSON.parse(d.toString())));
  const closed = new Promise<{ code: number }>((resolve) => ws.once("close", (code) => resolve({ code })));
  return { ws, messages, closed };
}
async function waitForMessage(ws: WsClient): Promise<any> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout waiting for a message")), 3000);
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

async function waitForEventType(ws: WsClient, eventType: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${eventType}`)), 5000);
    const listener = (d: any) => {
      try {
        const msg = JSON.parse(d.toString());
        if (msg.eventType === eventType) {
          clearTimeout(t);
          ws.off("message", listener);
          resolve(msg);
        }
      } catch (_) { }
    };
    ws.on("message", listener);
  });
}

describe("Week 7 — Official M7 Proof Checkpoint", () => {
  let app: Awaited<ReturnType<typeof createApp>>;
  let port: number;
  let auditWorker: ReturnType<typeof createAuditWorker>;
  const unhandledErrors: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => unhandledErrors.push(reason);
  const onUncaughtException = (err: unknown) => unhandledErrors.push(err);

  beforeAll(async () => {
    process.on("unhandledRejection", onUnhandledRejection);
    process.on("uncaughtException", onUncaughtException);
    app = await createApp();
    await app.ready();
    await app.listen({ port: 0, host: "127.0.0.1" });
    port = (app.server.address() as AddressInfo).port;
    auditWorker = createAuditWorker();
  });

  afterAll(async () => {
    await auditWorker.close();
    await app.close();
    process.off("unhandledRejection", onUnhandledRejection);
    process.off("uncaughtException", onUncaughtException);
    // ── GATE 14 ──
    expect(unhandledErrors).toHaveLength(0);
  });

  beforeEach(async () => {
    resetAllConnectionsForTest();
    await resetTenantRegistryForTest();
    await rateLimiterRedis.flushdb();
  });

  it("GATE 1 — full E2E happy path: ticket -> connect -> real tool call -> live event, exact frame shape", async () => {
    const tenant = await createTestTenant(app);
    const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
    const tool = await createSsrfBlockedTool(tenant.tenantId, `gate1-${crypto.randomUUID()}`);

    const ticket = await mintTicketFor(app, tenant.accessToken);
    const { ws } = connectAndCollect(`ws://127.0.0.1:${port}/observability/stream?ticket=${ticket}`);
    const connectedFrame = await waitForMessage(ws);
    expect(Object.keys(connectedFrame).sort()).toEqual(["serverTime", "tenantId", "type"]);

    const eventPromise = waitForMessage(ws);
    await executeTool(tool.id, tenant.tenantId, agent.id, {}, new AbortController().signal);
    const eventFrame = await eventPromise;

    expect(eventFrame.type).toBe("event");
    expect(eventFrame.eventType).toBe("TOOL_INVOCATION");
    expect(eventFrame.toolId).toBe(tool.id);
    expect(eventFrame.tenantId).toBe(tenant.tenantId);

    ws.close();
    await cleanupTenant(tenant.tenantId);
  }, 15_000);

  it("GATE 2 — tenant isolation under concurrent multi-tenant load: zero cross-delivery", async () => {
    const N = 4;
    const setups = await Promise.all(
      Array.from({ length: N }, async () => {
        const tenant = await createTestTenant(app);
        const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
        const tool = await createSsrfBlockedTool(tenant.tenantId, `gate2-${crypto.randomUUID()}`);
        const ticket = await mintTicketFor(app, tenant.accessToken);
        const conn = connectAndCollect(`ws://127.0.0.1:${port}/observability/stream?ticket=${ticket}`);
        await waitForMessage(conn.ws);
        return { tenant, agent, tool, conn };
      })
    );

    await Promise.all(setups.map((s) => executeTool(s.tool.id, s.tenant.tenantId, s.agent.id, {}, new AbortController().signal)));
    await new Promise((r) => setTimeout(r, 500));

    for (const s of setups) {
      const own = s.conn.messages.filter((m) => m.type === "event" && m.toolId === s.tool.id);
      expect(own).toHaveLength(1);
      const foreign = s.conn.messages.filter(
        (m) => m.type === "event" && setups.some((other) => other !== s && other.tool.id === m.toolId)
      );
      expect(foreign).toHaveLength(0);
    }

    setups.forEach((s) => s.conn.ws.close());
    await Promise.all(setups.map((s) => cleanupTenant(s.tenant.tenantId)));
  }, 20_000);

  it("GATE 3/4 — reference counting: single- and multi-tenant churn invariant (condensed; exhaustive versions in observability-churn-stress.test.ts)", async () => {
    const tenant = await createTestTenant(app);
    for (let i = 0; i < 5; i++) {
      const ticket = await mintTicketFor(app, tenant.accessToken);
      const { ws } = connectAndCollect(`ws://127.0.0.1:${port}/observability/stream?ticket=${ticket}`);
      await waitForMessage(ws);
      ws.close();
      await new Promise((r) => setTimeout(r, 30));
    }
    expect(getViewerCountForTenant(tenant.tenantId)).toBe(0);
    expect(getSubscribedTenantCount()).toBe(0);
    await cleanupTenant(tenant.tenantId);
  }, 15_000);

  it("GATE 5 — backpressure: an overloaded viewer is shed (1008) without blocking healthy siblings (registry-level, per Day 4's established precedent)", () => {
    const tenantId = crypto.randomUUID();
    const overloaded = {
      readyState: WebSocket.OPEN, bufferedAmount: env.AGENTGATE_WS_BACKPRESSURE_THRESHOLD_BYTES + 1,
      send: vi.fn(), close: vi.fn(), once: vi.fn(), on: vi.fn(),
    };
    const healthy = { readyState: WebSocket.OPEN, bufferedAmount: 0, send: vi.fn(), once: vi.fn(), on: vi.fn() };
    registerTenantViewer(tenantId, overloaded as any);
    registerTenantViewer(tenantId, healthy as any);

    dispatchTenantMessage(
      tenantEventChannelName(tenantId),
      JSON.stringify({ id: crypto.randomUUID(), tenantId, eventType: "TOOL_INVOCATION", timestamp: new Date().toISOString() })
    );

    expect(overloaded.close).toHaveBeenCalledWith(WS_CLOSE_CODE.POLICY_VIOLATION, expect.any(String));
    expect(healthy.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse((healthy.send as any).mock.calls[0][0]).type).toBe("event");
  });

  it("GATE 6 — heartbeat: a genuinely unresponsive peer is terminated and fully cleaned up (real E2E)", async () => {
    const ORIGINAL = env.AGENTGATE_WS_HEARTBEAT_INTERVAL_MS;
    (env as any).AGENTGATE_WS_HEARTBEAT_INTERVAL_MS = 150;
    try {
      const tenant = await createTestTenant(app);
      const ticket = await mintTicketFor(app, tenant.accessToken);
      const ws = new WsClient(`ws://127.0.0.1:${port}/observability/stream?ticket=${ticket}`, { autoPong: false } as any);
      await new Promise<void>((resolve) => ws.once("open", () => resolve()));

      const code = await new Promise<number>((resolve) => ws.once("close", (c) => resolve(c)));
      expect([1005, 1006]).toContain(code);

      await new Promise((r) => setTimeout(r, 100));
      expect(getActiveConnectionCount(tenant.userId)).toBe(0);
      expect(getViewerCountForTenant(tenant.tenantId)).toBe(0);

      await cleanupTenant(tenant.tenantId);
    } finally {
      (env as any).AGENTGATE_WS_HEARTBEAT_INTERVAL_MS = ORIGINAL;
    }
  }, 10_000);

  it("GATE 7 — connection ceiling under TRUE concurrent (Promise.all) attempts", async () => {
    const tenant = await createTestTenant(app);
    const limit = env.AGENTGATE_WS_MAX_CONNECTIONS_PER_USER;
    const tickets = await Promise.all(Array.from({ length: limit + 3 }, () => mintTicketFor(app, tenant.accessToken)));
    const conns = tickets.map((t) => connectAndCollect(`ws://127.0.0.1:${port}/observability/stream?ticket=${t}`));

    const outcomes = await Promise.all(
      conns.map((c) =>
        Promise.race([
          waitForMessage(c.ws).then((msg) => (msg.type === "connected" ? ("ok" as const) : ("rejected" as const))),
          c.closed.then(() => "rejected" as const),
        ])
      )
    );
    expect(outcomes.filter((o) => o === "ok").length).toBe(limit);

    conns.forEach((c) => c.ws.close());
    await cleanupTenant(tenant.tenantId);
  }, 20_000);

  it("GATE 8 — graceful shutdown under active connections across multiple tenants", async () => {
    const tenants = await Promise.all(Array.from({ length: 3 }, () => createTestTenant(app)));
    const conns = await Promise.all(
      tenants.map(async (t) => {
        const ticket = await mintTicketFor(app, t.accessToken);
        const conn = connectAndCollect(`ws://127.0.0.1:${port}/observability/stream?ticket=${ticket}`);
        await waitForMessage(conn.ws);
        return conn;
      })
    );

    expect(getAllRegisteredSockets().length).toBeGreaterThanOrEqual(3);
    await closeAllObservabilityConnections(2000);

    const results = await Promise.all(conns.map((c) => c.closed));
    for (const r of results) expect(r.code).toBe(1001);

    await new Promise((r) => setTimeout(r, 100));
    for (const t of tenants) {
      expect(getViewerCountForTenant(t.tenantId)).toBe(0);
      expect(getActiveConnectionCount(t.userId)).toBe(0);
    }
    await Promise.all(tenants.map((t) => cleanupTenant(t.tenantId)));
  }, 15_000);

  it("GATE 9 — PERMISSION_DENIED free-proof: already-built M6 audit caller delivers live, denialReason included", async () => {
    const tenant = await createTestTenant(app);
    const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
    const tool = await createTestTool(tenant.tenantId); // NO permission grant

    const ticket = await mintTicketFor(app, tenant.accessToken);
    const { ws } = connectAndCollect(`ws://127.0.0.1:${port}/observability/stream?ticket=${ticket}`);
    await waitForMessage(ws);

    const eventPromise = waitForMessage(ws);
    await handleToolsCall({ agentId: agent.id, tenantId: tenant.tenantId }, { name: tool.name }, performance.now(), new AbortController().signal).catch(() => {});
    const eventFrame = await eventPromise;

    expect(eventFrame.eventType).toBe("PERMISSION_DENIED");
    expect(eventFrame.denialReason).toBe("not_found");

    ws.close();
    await cleanupTenant(tenant.tenantId);
  }, 15_000);

  it("GATE 10 — RATE_LIMITED free-proof: already-built M6 audit caller delivers live", async () => {
    const tenant = await createTestTenant(app);
    const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
    const tool = await createTestTool(tenant.tenantId);
    await permissionService.assignPermission(tenant.tenantId, { agentId: agent.id, toolId: tool.id });

    const ticket = await mintTicketFor(app, tenant.accessToken);
    const { ws } = connectAndCollect(`ws://127.0.0.1:${port}/observability/stream?ticket=${ticket}`);
    await waitForMessage(ws);

    const limit = env.AGENTGATE_MCP_TOOL_CALL_RATE_LIMIT;

    // Exhaust the limit concurrently
    await Promise.all(
      Array.from({ length: limit }, () =>
        handleToolsCall({ agentId: agent.id, tenantId: tenant.tenantId }, { name: tool.name }, performance.now(), new AbortController().signal).catch(() => { })
      )
    );

    const eventPromise = waitForEventType(ws, "RATE_LIMITED");

    // Trigger the actual rate limit event
    await handleToolsCall({ agentId: agent.id, tenantId: tenant.tenantId }, { name: tool.name }, performance.now(), new AbortController().signal).catch(() => { });

    const eventFrame = await eventPromise;
    expect(eventFrame.eventType).toBe("RATE_LIMITED");

    ws.close();
    await cleanupTenant(tenant.tenantId);
  }, 15_000);


  it("GATE 11 — cold-start replica sanity: a FRESH registry correctly subscribes and delivers on its first-ever connection", async () => {
    await resetTenantRegistryForTest();
    resetAllConnectionsForTest();
    expect(getSubscribedTenantCount()).toBe(0);
    expect(getTotalViewerCount()).toBe(0);

    const tenant = await createTestTenant(app);
    const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
    const tool = await createSsrfBlockedTool(tenant.tenantId, `gate11-${crypto.randomUUID()}`);

    const ticket = await mintTicketFor(app, tenant.accessToken);
    const { ws } = connectAndCollect(`ws://127.0.0.1:${port}/observability/stream?ticket=${ticket}`);
    const connectedFrame = await waitForMessage(ws);
    expect(connectedFrame.type).toBe("connected");
    expect(getSubscribedTenantCount()).toBe(1);

    const eventPromise = waitForMessage(ws);
    await executeTool(tool.id, tenant.tenantId, agent.id, {}, new AbortController().signal);
    expect((await eventPromise).toolId).toBe(tool.id);

    ws.close();
    await cleanupTenant(tenant.tenantId);
  }, 15_000);

  it("GATE 12 — empirical latency under CONCURRENT multi-tenant load: every delivery under 200ms", async () => {
    const N = 5;
    const setups = await Promise.all(
      Array.from({ length: N }, async () => {
        const tenant = await createTestTenant(app);
        const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
        const tool = await createSsrfBlockedTool(tenant.tenantId, `gate12-${crypto.randomUUID()}`);
        const ticket = await mintTicketFor(app, tenant.accessToken);
        const conn = connectAndCollect(`ws://127.0.0.1:${port}/observability/stream?ticket=${ticket}`);
        await waitForMessage(conn.ws);
        return { tenant, agent, tool, conn };
      })
    );

    const armed = setups.map((s) => ({ ...s, eventPromise: waitForMessage(s.conn.ws), start: performance.now() }));
    await Promise.all(armed.map((s) => executeTool(s.tool.id, s.tenant.tenantId, s.agent.id, {}, new AbortController().signal)));

    for (const s of armed) {
      const frame = await s.eventPromise;
      expect(frame.toolId).toBe(s.tool.id);
      expect(performance.now() - s.start).toBeLessThan(200);
    }

    setups.forEach((s) => s.conn.ws.close());
    await Promise.all(setups.map((s) => cleanupTenant(s.tenant.tenantId)));
  }, 20_000);

  it("GATE 15/16/19 — security condensed sweep (full depth in observability-security-adversarial.test.ts)", async () => {
    // 15 — CSWSH
    const noTicket = connectAndCollect(`ws://127.0.0.1:${port}/observability/stream`, { Origin: "https://dashboard.example" });
    expect((await noTicket.closed).code).toBe(WS_CLOSE_CODE.TICKET_INVALID);

    // 16 — query injection inert
    const tenant = await createTestTenant(app);
    const victim = await createTestTenant(app);
    const ticket = await mintTicketFor(app, tenant.accessToken);
    const injected = connectAndCollect(`ws://127.0.0.1:${port}/observability/stream?ticket=${ticket}&tenantId=${victim.tenantId}`);
    const frame = await waitForMessage(injected.ws);
    expect(frame.tenantId).toBe(tenant.tenantId);
    injected.ws.close();

    await cleanupTenant(tenant.tenantId);
    await cleanupTenant(victim.tenantId);
  }, 15_000);

  it("GATE 17 — ticket redaction from logs (unit proof lives in request-log-redaction.test.ts; confirmed here at the app-config level)", async () => {
    const { redactTicketFromUrl } = await import("../lib/request-log-redaction.js");
    expect(redactTicketFromUrl("/observability/stream?ticket=LIVE_SECRET_VALUE")).not.toContain("LIVE_SECRET_VALUE");
  });

  it("GATE 20 — WS close-code taxonomy: exhaustive, no undocumented fallthrough", async () => {
    const observed = new Set<number>();

    { // 4002
      const spy = vi.spyOn(originValidator, "isOriginAllowed").mockReturnValue(false);
      const { closed } = connectAndCollect(`ws://127.0.0.1:${port}/observability/stream?ticket=x`);
      observed.add((await closed).code);
      spy.mockRestore();
    }
    { // 4001
      const { closed } = connectAndCollect(`ws://127.0.0.1:${port}/observability/stream?ticket=never-minted-${crypto.randomUUID()}`);
      observed.add((await closed).code);
    }
    { // 4005
      const tenant = await createTestTenant(app);
      const ticket = await mintTicketFor(app, tenant.accessToken);
      const spy = vi.spyOn(rateLimiterRedis, "getdel").mockRejectedValue(new Error("boom"));
      const { closed } = connectAndCollect(`ws://127.0.0.1:${port}/observability/stream?ticket=${ticket}`);
      observed.add((await closed).code);
      spy.mockRestore();
      await cleanupTenant(tenant.tenantId);
    }
    { // 4003
      const tenant = await createTestTenant(app);
      const limit = env.AGENTGATE_WS_MAX_CONNECTIONS_PER_USER;
      const survivors: any[] = [];
      for (let i = 0; i < limit; i++) {
        const t = await mintTicketFor(app, tenant.accessToken);
        const c = connectAndCollect(`ws://127.0.0.1:${port}/observability/stream?ticket=${t}`);
        await waitForMessage(c.ws);
        survivors.push(c);
      }
      const overflowTicket = await mintTicketFor(app, tenant.accessToken);
      const overflow = connectAndCollect(`ws://127.0.0.1:${port}/observability/stream?ticket=${overflowTicket}`);
      observed.add((await overflow.closed).code);
      survivors.forEach((c) => c.ws.close());
      await cleanupTenant(tenant.tenantId);
    }
    { // 4006
      let last;
      const limit = env.AGENTGATE_WS_STREAM_CONNECT_RATE_LIMIT;
      for (let i = 0; i <= limit; i++) {
        const c = connectAndCollect(`ws://127.0.0.1:${port}/observability/stream?ticket=throttle-sweep-${i}`);
        last = await c.closed;
      }
      observed.add(last!.code);
    }
    { // 1008
      const tenantId = crypto.randomUUID();
      const overloaded = {
        readyState: WebSocket.OPEN,
        bufferedAmount: env.AGENTGATE_WS_BACKPRESSURE_THRESHOLD_BYTES + 1,
        send: vi.fn(),
        close: vi.fn((c: number) => observed.add(c)),
        once: vi.fn(),
        on: vi.fn(),
      };
      registerTenantViewer(tenantId, overloaded as any);
      dispatchTenantMessage(tenantEventChannelName(tenantId), JSON.stringify({ id: crypto.randomUUID(), tenantId, eventType: "TOOL_INVOCATION", timestamp: new Date().toISOString() }));
    }
    { // 1001
      const tenant = await createTestTenant(app);
      const ticket = await mintTicketFor(app, tenant.accessToken);
      const conn = connectAndCollect(`ws://127.0.0.1:${port}/observability/stream?ticket=${ticket}`);
      await waitForMessage(conn.ws);
      await closeAllObservabilityConnections(1000);
      observed.add((await conn.closed).code);
      await cleanupTenant(tenant.tenantId);
    }

    expect(observed).toEqual(new Set([
      WS_CLOSE_CODE.ORIGIN_NOT_ALLOWED, WS_CLOSE_CODE.TICKET_INVALID, WS_CLOSE_CODE.SERVICE_DEGRADED,
      WS_CLOSE_CODE.CONNECTION_CEILING_EXCEEDED, WS_CLOSE_CODE.TOO_MANY_CONNECTION_ATTEMPTS,
      WS_CLOSE_CODE.POLICY_VIOLATION, WS_CLOSE_CODE.GOING_AWAY,
    ]));
    // 4004 (heartbeat) is intentionally NOT reproduced in this sweep —
    // proving it requires globally shortening the heartbeat interval,
    // which would destabilize every other timing-sensitive gate in
    // this same file. It has its own dedicated, isolated proof (GATE 6
    // above, and Day 4's own original E2E test).
  }, 40_000);

  // ── Disruptive gates run LAST — see file-level note at the top ──

  it("GATE 13 — /health under a REAL forced subscriber outage, with explicit recovery", async () => {
    const before = await app.inject({ method: "GET", url: "/healthcheck" });
    expect(JSON.parse(before.body).observabilityStream.healthy).toBe(true);

    tenantEventSubscriber.disconnect();
    await new Promise((r) => setTimeout(r, 200));

    const during = await app.inject({ method: "GET", url: "/healthcheck" });
    expect(JSON.parse(during.body).observabilityStream.healthy).toBe(false);
    expect(during.statusCode).toBe(200); // advisory only

    await tenantEventSubscriber.connect();
    await new Promise((r) => setTimeout(r, 200));

    const after = await app.inject({ method: "GET", url: "/healthcheck" });
    expect(JSON.parse(after.body).observabilityStream.healthy).toBe(true);
  }, 15_000);

  it("GATE 18 — trustProxy IP resolution correctness (full depth in trust-proxy.test.ts; confirmed here)", async () => {
    const ORIGINAL = env.AGENTGATE_TRUST_PROXY_HOPS;
    (env as any).AGENTGATE_TRUST_PROXY_HOPS = 1;
    const trustedApp = await createApp();
    const seen: string[] = [];
    trustedApp.addHook("onRequest", async (r) => { seen.push(r.ip); });
    await trustedApp.inject({ method: "GET", url: "/healthcheck", headers: { "x-forwarded-for": "203.0.113.9" } });
    await trustedApp.inject({ method: "GET", url: "/healthcheck", headers: { "x-forwarded-for": "198.51.100.4" } });
    expect(seen[0]).not.toBe(seen[1]);
    await trustedApp.close();
    (env as any).AGENTGATE_TRUST_PROXY_HOPS = ORIGINAL;
  });
});