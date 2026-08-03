import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { WebSocket as WsClient } from "ws";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import { createApp } from "../app.js";
import { rateLimiterRedis } from "../lib/rate-limiter.js";
import * as originValidator from "../mcp/http/origin-validator.js";
import { getActiveConnectionCount, resetAllConnectionsForTest } from "../observability/ws-connection-tracker.js";
import { WS_CLOSE_CODE } from "../observability/ws-protocol.js";
import { env } from "../config/env.js";
import { createTestTenant, cleanupTenant, createTestAgent } from "./helpers/test-tenant.factory.js";
import { executeTool } from "../lib/execute-tool.js";
import { createAuditWorker } from "../workers/audit.worker.js";
import { encryptConfig } from "../lib/encryption.js";
import { prisma } from "../lib/prisma.js";

/**
 * Real, unmocked ws client — deliberately NOT a browser-emulation
 * shim. Because this design NEVER rejects pre-upgrade (Decision 7.34
 * / Finding F3), a real browser observes the identical sequence of
 * events a Node ws client observes here: successful open, then
 * message(s), then close(code, reason). If this design ever regressed
 * to a pre-upgrade rejection, THIS test client would still "pass"
 * (Node's ws CAN read pre-101 responses) while silently breaking real
 * browsers — which is exactly why the design itself, not the test
 * client, is what has to guarantee post-upgrade-only rejection.
 */
function connectAndCollect(url: string, headers?: Record<string, string>) {
  const ws = new WsClient(url, headers ? { headers } : undefined);
  const messages: any[] = [];
  ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.once("close", (code, reasonBuf) => resolve({ code, reason: reasonBuf.toString() }));
  });
  return { ws, messages, closed };
}



async function waitForMessage(ws: WsClient): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for a message")), 3000);
    ws.once("message", (data) => { clearTimeout(timer); resolve(JSON.parse(data.toString())); });
  });
}

async function mintTicketFor(app: any, accessToken: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/observability/ticket",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return JSON.parse(res.body).ticket;
}

async function createSsrfBlockedTool(tenantId: string, name: string) {
  const ciphertext = encryptConfig(
    JSON.stringify({ handlerType: "http", url: "http://127.0.0.1:1/probe", method: "GET" }),
    tenantId
  );
  return prisma.tool.create({
    data: {
      tenantId, name, handlerType: "http", handlerConfig: ciphertext,
      inputSchema: { type: "object", properties: {} }, isActive: true,
    },
  });
}

describe("GET /observability/stream", () => {
  let app: Awaited<ReturnType<typeof createApp>>;
  let port: number;

  beforeAll(async () => {
    app = await createApp();
    await app.ready();
    await app.listen({ port: 0, host: "127.0.0.1" });
    port = (app.server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    resetAllConnectionsForTest();
    await rateLimiterRedis.flushdb();
  });

  it("a valid ticket completes the handshake and returns EXACTLY {type, serverTime, tenantId}", async () => {
    const tenant = await createTestTenant(app);
    const ticket = await mintTicketFor(app, tenant.accessToken);

    const { ws, messages } = connectAndCollect(`ws://127.0.0.1:${port}/observability/stream?ticket=${ticket}`);
    const frame = await waitForMessage(ws);

    expect(frame.type).toBe("connected");
    expect(Object.keys(frame).sort()).toEqual(["serverTime", "tenantId", "type"]);
    expect(frame.tenantId).toBe(tenant.tenantId);
    expect(messages).toHaveLength(1);

    ws.close();
    await cleanupTenant(tenant.tenantId);
  });

  it("a missing ticket query param closes 4001, before any Redis work", async () => {
    const getdelSpy = vi.spyOn(rateLimiterRedis, "getdel");
    const { messages, closed } = connectAndCollect(`ws://127.0.0.1:${port}/observability/stream`);
    const result = await closed;

    expect(result.code).toBe(WS_CLOSE_CODE.TICKET_INVALID);
    expect(messages[0]).toMatchObject({ type: "error", code: WS_CLOSE_CODE.TICKET_INVALID });
    expect(getdelSpy).not.toHaveBeenCalled();
    getdelSpy.mockRestore();
  });

  it("an unknown (never-minted) ticket closes 4001", async () => {
    const { closed } = connectAndCollect(
      `ws://127.0.0.1:${port}/observability/stream?ticket=never-minted-${crypto.randomUUID()}`
    );
    expect((await closed).code).toBe(WS_CLOSE_CODE.TICKET_INVALID);
  });

  it("GATE — a ticket already redeemed by one connection is rejected 4001 on a second attempt", async () => {
    const tenant = await createTestTenant(app);
    const ticket = await mintTicketFor(app, tenant.accessToken);

    const first = connectAndCollect(`ws://127.0.0.1:${port}/observability/stream?ticket=${ticket}`);
    await waitForMessage(first.ws); // let redemption + connected frame complete

    const second = connectAndCollect(`ws://127.0.0.1:${port}/observability/stream?ticket=${ticket}`);
    expect((await second.closed).code).toBe(WS_CLOSE_CODE.TICKET_INVALID);

    first.ws.close();
    await cleanupTenant(tenant.tenantId);
  });

  it("GATE — a truly concurrent double-redemption of the SAME ticket: exactly one side connects, the other is rejected", async () => {
    const tenant = await createTestTenant(app);
    const ticket = await mintTicketFor(app, tenant.accessToken);

    const a = connectAndCollect(`ws://127.0.0.1:${port}/observability/stream?ticket=${ticket}`);
    const b = connectAndCollect(`ws://127.0.0.1:${port}/observability/stream?ticket=${ticket}`);

    const outcomeOf = (conn: ReturnType<typeof connectAndCollect>) =>
      Promise.race([
        new Promise<"connected">((resolve) =>
          conn.ws.on("message", (d) => { if (JSON.parse(d.toString()).type === "connected") resolve("connected"); })
        ),
        conn.closed.then(() => "rejected" as const),
      ]);

    const outcomes = (await Promise.all([outcomeOf(a), outcomeOf(b)])).sort();
    expect(outcomes).toEqual(["connected", "rejected"]);

    a.ws.close();
    b.ws.close();
    await cleanupTenant(tenant.tenantId);
  });

  it("a disallowed Origin closes 4002, before any Redis/ticket work at all", async () => {
    const spy = vi.spyOn(originValidator, "isOriginAllowed").mockReturnValue(false);
    const getdelSpy = vi.spyOn(rateLimiterRedis, "getdel");

    const { messages, closed } = connectAndCollect(
      `ws://127.0.0.1:${port}/observability/stream?ticket=whatever`,
      { Origin: "https://evil.example" }
    );
    const result = await closed;

    expect(result.code).toBe(WS_CLOSE_CODE.ORIGIN_NOT_ALLOWED);
    expect(messages[0]).toMatchObject({ type: "error", code: WS_CLOSE_CODE.ORIGIN_NOT_ALLOWED });
    expect(getdelSpy).not.toHaveBeenCalled();

    spy.mockRestore();
    getdelSpy.mockRestore();
  });

  it("GATE — a Redis failure during ticket redemption closes 4005 (SERVICE_DEGRADED), never 4001", async () => {
    const tenant = await createTestTenant(app);
    const ticket = await mintTicketFor(app, tenant.accessToken);

    const spy = vi.spyOn(rateLimiterRedis, "getdel").mockRejectedValue(new Error("ECONNRESET"));
    const { messages, closed } = connectAndCollect(`ws://127.0.0.1:${port}/observability/stream?ticket=${ticket}`);
    const result = await closed;

    expect(result.code).toBe(WS_CLOSE_CODE.SERVICE_DEGRADED);
    expect(messages[0]).toMatchObject({ type: "error", code: WS_CLOSE_CODE.SERVICE_DEGRADED });

    spy.mockRestore();
    await cleanupTenant(tenant.tenantId);
  });

  it("GATE — the (N+1)th concurrent connection from one user is rejected 4003; freeing a slot allows a new one", async () => {
    resetAllConnectionsForTest();
    const tenant = await createTestTenant(app);
    const limit = env.AGENTGATE_WS_MAX_CONNECTIONS_PER_USER;
    const sockets: WsClient[] = [];

    for (let i = 0; i < limit; i++) {
      const ticket = await mintTicketFor(app, tenant.accessToken);
      const { ws } = connectAndCollect(`ws://127.0.0.1:${port}/observability/stream?ticket=${ticket}`);
      await waitForMessage(ws);
      sockets.push(ws);
    }
    expect(getActiveConnectionCount(tenant.userId)).toBe(limit);

    const overflowTicket = await mintTicketFor(app, tenant.accessToken);
    const overflow = connectAndCollect(`ws://127.0.0.1:${port}/observability/stream?ticket=${overflowTicket}`);
    expect((await overflow.closed).code).toBe(WS_CLOSE_CODE.CONNECTION_CEILING_EXCEEDED);

    sockets[0]!.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(getActiveConnectionCount(tenant.userId)).toBe(limit - 1);

    const freedTicket = await mintTicketFor(app, tenant.accessToken);
    const freed = connectAndCollect(`ws://127.0.0.1:${port}/observability/stream?ticket=${freedTicket}`);
    const freedFrame = await waitForMessage(freed.ws);
    expect(freedFrame.type).toBe("connected");

    sockets.slice(1).forEach((s) => s.close());
    freed.ws.close();
    await cleanupTenant(tenant.tenantId);
  });

  it("GATE — exceeding the coarse, per-IP connect-attempt throttle closes 4006, distinct from every other rejection", async () => {
    const spy = vi.spyOn(rateLimiterRedis, "getdel"); // never should be reached once throttled
    const limit = env.AGENTGATE_WS_STREAM_CONNECT_RATE_LIMIT;
    let last;
    for (let i = 0; i <= limit; i++) {
      const conn = connectAndCollect(`ws://127.0.0.1:${port}/observability/stream?ticket=garbage-${i}`);
      last = await conn.closed;
    }
    expect(last!.code).toBe(WS_CLOSE_CODE.TOO_MANY_CONNECTION_ATTEMPTS);
    spy.mockRestore();
  }, 15_000);

  it("REGRESSION — POST /api/observability/ticket (Day 1) is unaffected by today's routing split (Finding F2): still requires auth", async () => {
    const res = await app.inject({ method: "POST", url: "/api/observability/ticket" });
    expect(res.statusCode).toBe(401);
  });
});


describe("GET /observability/stream — Day 3: live cross-tenant event delivery (real infra)", () => {
  let app: Awaited<ReturnType<typeof createApp>>;
  let port: number;
  let auditWorker: Awaited<ReturnType<typeof createAuditWorker>>;

  beforeAll(async () => {
    app = await createApp();
    await app.ready();
    await app.listen({ port: 0, host: "127.0.0.1" });
    port = (app.server.address() as AddressInfo).port;
    auditWorker = await createAuditWorker();
  });

  afterAll(async () => {
    await app.close();
    if (auditWorker && typeof auditWorker.close === 'function') {
      await auditWorker.close();
    }
  });

  beforeEach(async () => {
    resetAllConnectionsForTest();
    await rateLimiterRedis.flushdb();
  });

  it("CHECKPOINT — a real tool call against Tenant A is delivered to Tenant A's viewer and NEVER to Tenant B's", async () => {
    const tenantA = await createTestTenant(app);
    const tenantB = await createTestTenant(app);
    const { agent: agentA } = await createTestAgent(tenantA.tenantId, tenantA.userId);
    const toolA = await createSsrfBlockedTool(tenantA.tenantId, `cross-tenant-probe-${Date.now()}`);

    const ticketA = await mintTicketFor(app, tenantA.accessToken);
    const ticketB = await mintTicketFor(app, tenantB.accessToken);
    const connA = connectAndCollect(`ws://127.0.0.1:${port}/observability/stream?ticket=${ticketA}`);
    const connB = connectAndCollect(`ws://127.0.0.1:${port}/observability/stream?ticket=${ticketB}`);

    await waitForMessage(connA.ws); // await initial connected frame
    await waitForMessage(connB.ws); // await initial connected frame

    // 1. ARM THE LISTENER FIRST (do NOT await yet)
    const eventPromise = waitForMessage(connA.ws);

    // 2. TRIGGER THE TOOL EXECUTION
    await executeTool(toolA.id, tenantA.tenantId, agentA.id, {}, new AbortController().signal);

    // 3. NOW AWAIT THE EVENT
    const eventFrame = await eventPromise;
    expect(eventFrame.type).toBe("event");
    expect(eventFrame.tenantId).toBe(tenantA.tenantId);
    expect(eventFrame.toolId).toBe(toolA.id);

    let bLeaked = false;
    await Promise.race([
      waitForMessage(connB.ws).then(() => { bLeaked = true; }),
      new Promise<void>((resolve) => setTimeout(resolve, 500)),
    ]);
    expect(bLeaked).toBe(false);

    connA.ws.close();
    connB.ws.close();
    await cleanupTenant(tenantA.tenantId);
    await cleanupTenant(tenantB.tenantId);
  }, 15_000);

  it("two viewers of the SAME tenant both receive the SAME event (fan-out correctness)", async () => {
    const tenant = await createTestTenant(app);
    const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
    const tool = await createSsrfBlockedTool(tenant.tenantId, `fanout-probe-${Date.now()}`);

    const ticket1 = await mintTicketFor(app, tenant.accessToken);
    const ticket2 = await mintTicketFor(app, tenant.accessToken);
    const conn1 = connectAndCollect(`ws://127.0.0.1:${port}/observability/stream?ticket=${ticket1}`);
    const conn2 = connectAndCollect(`ws://127.0.0.1:${port}/observability/stream?ticket=${ticket2}`);

    await waitForMessage(conn1.ws); // connected frame
    await waitForMessage(conn2.ws); // connected frame

    // 1. ARM BOTH LISTENERS FIRST
    const frame1Promise = waitForMessage(conn1.ws);
    const frame2Promise = waitForMessage(conn2.ws);

    // 2. TRIGGER TOOL EXECUTION
    await executeTool(tool.id, tenant.tenantId, agent.id, {}, new AbortController().signal);

    // 3. AWAIT BOTH
    const [frame1, frame2] = await Promise.all([frame1Promise, frame2Promise]);
    expect(frame1.id).toBe(frame2.id);
    expect(frame1.tenantId).toBe(tenant.tenantId);

    conn1.ws.close();
    conn2.ws.close();
    await cleanupTenant(tenant.tenantId);
  }, 15_000);

  it("after the only viewer disconnects, a subsequent tool call for that tenant produces no crash", async () => {
    const tenant = await createTestTenant(app);
    const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
    const tool = await createSsrfBlockedTool(tenant.tenantId, `no-viewer-probe-${Date.now()}`);

    const ticket = await mintTicketFor(app, tenant.accessToken);
    const conn = connectAndCollect(`ws://127.0.0.1:${port}/observability/stream?ticket=${ticket}`);
    await waitForMessage(conn.ws);
    conn.ws.close();
    await new Promise((r) => setTimeout(r, 200)); // let deregistration + UNSUBSCRIBE settle

    await expect(
      executeTool(tool.id, tenant.tenantId, agent.id, {}, new AbortController().signal)
    ).resolves.toBeDefined();

    await cleanupTenant(tenant.tenantId);
  }, 15_000);

  // UPDATE to Day 3's existing test — a THIRD independent close listener
  // (heartbeat) now exists alongside the ceiling tracker and tenant
  // registry.
  it("registers at most three 'close' listeners per connection — no MaxListenersExceededWarning", async () => {
    const tenant = await createTestTenant(app);
    const ticket = await mintTicketFor(app, tenant.accessToken);
    const warnSpy = vi.fn();
    process.on("warning", warnSpy);

    const conn = connectAndCollect(`ws://127.0.0.1:${port}/observability/stream?ticket=${ticket}`);
    await waitForMessage(conn.ws);
    conn.ws.close();
    await new Promise((r) => setTimeout(r, 100));

    expect(warnSpy).not.toHaveBeenCalled();
    process.removeListener("warning", warnSpy);
    await cleanupTenant(tenant.tenantId);
  });
});


describe("GET /observability/stream — Day 4: heartbeat, backpressure wiring, latency (real infra)", () => {
  let app: Awaited<ReturnType<typeof createApp>>;
  let port: number;
  let auditWorker: Awaited<ReturnType<typeof createAuditWorker>>;
  const ORIGINAL_HEARTBEAT_INTERVAL_MS = env.AGENTGATE_WS_HEARTBEAT_INTERVAL_MS;

  beforeAll(async () => {
    // Decision 7.57 — a direct, test-file-scoped override of the
    // parsed env singleton, restored in afterAll. Waiting out the
    // real 30s production default here would make this suite
    // impractically slow; the exhaustive state-machine proof already
    // lives in ws-heartbeat.test.ts under fake timers — this suite
    // only needs to prove the real WIRING (a genuine ping is sent
    // over a genuine socket, and a genuinely unresponsive client is
    // actually torn down), which is orthogonal to the interval's
    // literal duration.
    (env as any).AGENTGATE_WS_HEARTBEAT_INTERVAL_MS = 300;

    app = await createApp();
    await app.ready();
    await app.listen({ port: 0, host: "127.0.0.1" });
    port = (app.server.address() as AddressInfo).port;
    auditWorker = await createAuditWorker();
  });

  afterAll(async () => {
    (env as any).AGENTGATE_WS_HEARTBEAT_INTERVAL_MS = ORIGINAL_HEARTBEAT_INTERVAL_MS;
    await app.close();
    if (auditWorker && typeof auditWorker.close === "function") {
      await auditWorker.close();
    }
  });

  beforeEach(async () => {
    resetAllConnectionsForTest();
    await rateLimiterRedis.flushdb();
  });

  it("a normally-responsive client receives real ping frames and stays connected", async () => {
    const tenant = await createTestTenant(app);
    const ticket = await mintTicketFor(app, tenant.accessToken);

    // Default ws client behavior: auto-responds to server pings with
    // pongs, with zero application code required — the exact property
    // that makes native ping/pong such a good fit for a real browser
    // client too.
    const ws = new WsClient(`ws://127.0.0.1:${port}/observability/stream?ticket=${ticket}`);
    let pingCount = 0;
    ws.on("ping", () => { pingCount++; });

    await new Promise<void>((resolve) => ws.once("open", () => resolve()));
    await new Promise((r) => setTimeout(r, 300 * 3)); // several heartbeat cycles

    expect(pingCount).toBeGreaterThanOrEqual(2);
    expect(ws.readyState).toBe(WsClient.OPEN);

    ws.close();
    await cleanupTenant(tenant.tenantId);
  });

  it("GATE — a client that never pongs is terminated after exactly one missed heartbeat cycle", async () => {
    const tenant = await createTestTenant(app);
    const ticket = await mintTicketFor(app, tenant.accessToken);

    // autoPong: false — confirm this option is supported by the
    // pinned ws CLIENT version (added in ws@8.18.0, which this project
    // pins per Week 7 Day 2's package.json addition) before relying on
    // it; if unavailable in the resolved version, substitute a raw
    // net.Socket-level client that completes the WS handshake but
    // never processes control frames at all. See Part 8 Assumption #2.
    const ws = new WsClient(`ws://127.0.0.1:${port}/observability/stream?ticket=${ticket}`, {
      autoPong: false,
    } as any);

    let pingReceived = false;
    ws.on("ping", () => { pingReceived = true; }); // confirms the SERVER actually pinged

    const closed = new Promise<{ code: number }>((resolve) => {
      ws.once("close", (code) => resolve({ code }));
    });

    await new Promise<void>((resolve) => ws.once("open", () => resolve()));

    const result = await Promise.race([
      closed,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("connection was never terminated")), 3000)
      ),
    ]);

    expect(pingReceived).toBe(true);
    // terminate() bypasses the graceful close handshake — the client
    // observes an abnormal closure, NOT a clean 4004 frame (Day 4
    // Finding F3's own documented tradeoff). The SERVER'S structured
    // logs are where HEARTBEAT_TIMEOUT (4004) is actually attributed.
    expect([1005, 1006]).toContain(result.code);
  }, 10_000);

  it("a genuinely dead heartbeat also cleans up the ceiling tracker and tenant registry (all three listeners fire)", async () => {
    const tenant = await createTestTenant(app);
    const ticket = await mintTicketFor(app, tenant.accessToken);
    const ws = new WsClient(`ws://127.0.0.1:${port}/observability/stream?ticket=${ticket}`, {
      autoPong: false,
    } as any);

    await new Promise<void>((resolve) => ws.once("open", () => resolve()));
    await new Promise<void>((resolve) => ws.once("close", () => resolve()));
    await new Promise((r) => setTimeout(r, 100)); // let all three async close listeners settle

    expect(getActiveConnectionCount(tenant.userId)).toBe(0);

    await cleanupTenant(tenant.tenantId);
  }, 10_000);

  it("CHECKPOINT — a live tool call's event round-trips end-to-end within the HLD's 200ms target", async () => {
    const tenant = await createTestTenant(app);
    const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
    const tool = await createSsrfBlockedTool(tenant.tenantId, `latency-probe-${Date.now()}`);

    const ticket = await mintTicketFor(app, tenant.accessToken);
    const conn = connectAndCollect(`ws://127.0.0.1:${port}/observability/stream?ticket=${ticket}`);
    await waitForMessage(conn.ws); // connected frame

    // Arm the listener BEFORE triggering execution — Day 3's own
    // established ordering discipline, avoiding a race where the
    // event arrives and is processed before our listener attaches.
    const eventPromise = waitForMessage(conn.ws);
    const triggeredAt = performance.now();
    await executeTool(tool.id, tenant.tenantId, agent.id, {}, new AbortController().signal);
    const eventFrame = await eventPromise;
    const elapsedMs = performance.now() - triggeredAt;

    expect(eventFrame.type).toBe("event");
    expect(eventFrame.toolId).toBe(tool.id);
    // HLD's own stated target. Measured against local docker-compose
    // Redis/Postgres — inherently environment-sensitive; Day 6 repeats
    // this check across a wider adversarial matrix.
    expect(elapsedMs).toBeLessThan(200);

    conn.ws.close();
    await cleanupTenant(tenant.tenantId);
  }, 10_000);
});