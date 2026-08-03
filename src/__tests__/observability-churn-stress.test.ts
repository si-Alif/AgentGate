import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { WebSocket as WsClient } from "ws";
import type { AddressInfo } from "node:net";
import { createApp } from "../app.js";
import { rateLimiterRedis } from "../lib/rate-limiter.js";
import { tenantEventChannelName } from "../lib/audit-publish.js";
import {
  tenantEventSubscriber, getViewerCountForTenant, getSubscribedTenantCount, getTotalViewerCount,
} from "../observability/ws-tenant-registry.js";
import { resetAllConnectionsForTest } from "../observability/ws-connection-tracker.js";
import { createTestTenant, cleanupTenant } from "./helpers/test-tenant.factory.js";

function connectAndCollect(url: string) {
  const ws = new WsClient(url);
  const messages: any[] = [];
  ws.on("message", (d) => messages.push(JSON.parse(d.toString())));
  const closed = new Promise<{ code: number }>((resolve) => ws.once("close", (code) => resolve({ code })));
  return { ws, messages, closed };
}

async function waitForMessage(ws: WsClient): Promise<any> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), 3000);

    ws.on("message", function listener(d) {
      const msg = JSON.parse(d.toString());

      if (msg.type === "connected") {
        clearTimeout(t);
        ws.removeListener("message", listener);
        resolve(msg);
      } else if (msg.type === "error") {
        clearTimeout(t);
        ws.removeListener("message", listener);
        reject(new Error(`Server rejected connection: ${msg.message}`));
      }
    });
  });
}

async function mintTicketFor(app: any, accessToken: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/observability/ticket", headers: { Authorization: `Bearer ${accessToken}` } });
  const body = JSON.parse(res.body);

  if (!body.ticket) {
    throw new Error(`Failed to mint ticket (${res.statusCode}): ${res.body}`);
  }

  return body.ticket;
}

async function connectThenDisconnect(app: any, port: number, accessToken: string): Promise<void> {
  const ticket = await mintTicketFor(app, accessToken);
  const { ws } = connectAndCollect(`ws://127.0.0.1:${port}/observability/stream?ticket=${ticket}`);
  await waitForMessage(ws);
  ws.close();
  await new Promise((resolve) => ws.once("close", resolve));
}

describe("Week 7 Day 6 — Reference-Counting Under Real Concurrent Churn (Findings F4)", () => {
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

  it("GATE — 10 rapid SEQUENTIAL connect/disconnect cycles for one tenant leave zero leaked registry entries, with exact SUBSCRIBE/UNSUBSCRIBE parity", async () => {
    const tenant = await createTestTenant(app);
    const channel = tenantEventChannelName(tenant.tenantId);
    const subSpy = vi.spyOn(tenantEventSubscriber, "subscribe");
    const unsubSpy = vi.spyOn(tenantEventSubscriber, "unsubscribe");

    for (let i = 0; i < 10; i++) {
      await connectThenDisconnect(app, port, tenant.accessToken);
      await new Promise((r) => setTimeout(r, 25));
    }

    expect(getViewerCountForTenant(tenant.tenantId)).toBe(0);
    expect(getSubscribedTenantCount()).toBe(0);
    expect(subSpy.mock.calls.filter(([ch]) => ch === channel).length).toBe(10);
    expect(unsubSpy.mock.calls.filter(([ch]) => ch === channel).length).toBe(10);

    subSpy.mockRestore(); unsubSpy.mockRestore();
    await cleanupTenant(tenant.tenantId);
  }, 25_000);

  it("GATE — many TRULY CONCURRENT connect/disconnect cycles for one tenant converge to zero leaked state regardless of interleaving", async () => {
    const { env } = await import("../config/env.js");
    const tenant = await createTestTenant(app);

    // Limit concurrency to the max allowed connections per user (5)
    const limit = env.AGENTGATE_WS_MAX_CONNECTIONS_PER_USER;
    await Promise.all(Array.from({ length: limit }, () => connectThenDisconnect(app, port, tenant.accessToken)));
    await new Promise((r) => setTimeout(r, 250));

    expect(getViewerCountForTenant(tenant.tenantId)).toBe(0);
    expect(getSubscribedTenantCount()).toBe(0);
    await cleanupTenant(tenant.tenantId);
  }, 20_000);

  it("GATE — multi-tenant concurrent churn: total viewer count always equals the SUM of per-tenant counts, and unrelated tenants never interfere", async () => {
    const tenants = await Promise.all(Array.from({ length: 5 }, () => createTestTenant(app)));
    const persistent: any[] = [];

    await Promise.all(
      tenants.flatMap((t) => [
        connectThenDisconnect(app, port, t.accessToken),
        connectThenDisconnect(app, port, t.accessToken),
        connectThenDisconnect(app, port, t.accessToken),
        (async () => {
          const ticket = await mintTicketFor(app, t.accessToken);
          const conn = connectAndCollect(`ws://127.0.0.1:${port}/observability/stream?ticket=${ticket}`);
          await waitForMessage(conn.ws);
          persistent.push(conn);
        })(),
      ])
    );
    await new Promise((r) => setTimeout(r, 250));

    try {
      let sum = 0;
      for (const t of tenants) sum += getViewerCountForTenant(t.tenantId);
      expect(sum).toBe(getTotalViewerCount());
      expect(sum).toBe(5);
      expect(getSubscribedTenantCount()).toBe(5);
    } finally {
      persistent.forEach((c) => c.ws.close());
      await new Promise((r) => setTimeout(r, 250));

      expect(getTotalViewerCount()).toBe(0);
      expect(getSubscribedTenantCount()).toBe(0);

      await Promise.all(tenants.map((t) => cleanupTenant(t.tenantId)));
    }
  }, 30_000);
});

describe("Week 7 Day 6 — Connection Ceiling Under TRUE Concurrency (Finding F5)", () => {
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

  it("GATE — the per-user ceiling is enforced correctly under Promise.all concurrent connection attempts, not sequential ones", async () => {
    const { env } = await import("../config/env.js");
    const { getActiveConnectionCount } = await import("../observability/ws-connection-tracker.js");
    const tenant = await createTestTenant(app);

    const limit = env.AGENTGATE_WS_MAX_CONNECTIONS_PER_USER;
    const attemptCount = limit + 5;

    const tickets = await Promise.all(Array.from({ length: attemptCount }, () => mintTicketFor(app, tenant.accessToken)));
    const conns = tickets.map((t) => connectAndCollect(`ws://127.0.0.1:${port}/observability/stream?ticket=${t}`));

    try {
      const outcomes = await Promise.all(
        conns.map((c) => Promise.race([
          waitForMessage(c.ws)
            .then(() => "connected" as const)
            .catch(() => "rejected" as const),
          c.closed.then(() => "rejected" as const),
        ]))
      );

      expect(outcomes.filter((o) => o === "connected").length).toBe(limit);
      expect(outcomes.filter((o) => o === "rejected").length).toBe(attemptCount - limit);
      expect(getActiveConnectionCount(tenant.userId)).toBe(limit);
    } finally {
      conns.forEach((c) => c.ws.close());
      await cleanupTenant(tenant.tenantId);
    }
  }, 20_000);
});