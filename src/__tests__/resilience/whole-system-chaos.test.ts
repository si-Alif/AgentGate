import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WebSocket as WsClient } from "ws";
import { startFullSystem, stopFullSystem } from "../helpers/system-harness.js";
import type { SystemHarness } from "../helpers/system-harness.js";
import {
  createTestTenant,
  createTestAgent,
  createSsrfBlockedTool,
  cleanupTenant,
} from "../helpers/test-tenant.factory.js";
import { permissionService } from "../../services/permission.service.js";
import { killAllMainPoolBackends } from "./helpers/pg-chaos.js";
import { disconnectRateLimiterRedis, reconnectRateLimiterRedis } from "./helpers/redis-chaos.js";
import { getRateLimiterBreaker } from "../../lib/rate-limiter.js";
import { tenantEventSubscriber } from "../../observability/ws-tenant-registry.js";
import { createAuditWorker } from "../../workers/audit.worker.js";
import { auditPrisma } from "../../lib/audit-prisma.js";
import { drainAuditQueueAndCloseWorker } from "../helpers/audit-drain.js";
import { withTimeout } from "../../lib/timeout.js";
import { redis } from "../../lib/redis.js";
import { auditQueue } from "../../queue/audit.queue.js";
import { QueueEvents } from "bullmq";

async function callTool(app: any, apiKey: string, toolName: string, id: string | number) {
  const res = await app.inject({
    method: "POST", url: "/mcp",
    headers: { authorization: `Bearer ${apiKey}` },
    payload: { jsonrpc: "2.0", id, method: "tools/call", params: { name: toolName }, _meta: { protocolVersion: "2026-07-28" } },
  });
  return JSON.parse(res.body);
}

async function waitFor(assertion: () => Promise<void> | void, timeoutMs = 20_000, intervalMs = 300): Promise<void> {
  const start = Date.now();
  while (true) {
    try { await assertion(); return; } catch (err) {
      if (Date.now() - start > timeoutMs) throw err;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}

async function teardownIsolatedAuditWorker(
  worker: ReturnType<typeof createAuditWorker>,
  connection: ReturnType<typeof redis.duplicate>,
  timeoutMs = 2000
): Promise<void> {
  await withTimeout(() => worker.close(true), timeoutMs).catch(() => { });
  if (connection.status !== "end") {
    connection.disconnect();
  }
}

describe("Week 8, Day 4 — Whole-System Chaos Injection", () => {
  let harness: SystemHarness;
  let tenant: Awaited<ReturnType<typeof createTestTenant>>;
  let apiKey: string;
  let toolName: string;
  let toolId : string;
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);

  beforeAll(async () => {
    // Decision 8.92 — clean slate before creating test tenant
    await auditQueue.obliterate({ force: true }).catch(() => { });
    process.on("unhandledRejection", onUnhandled);
    process.on("uncaughtException", onUnhandled);

    harness = await startFullSystem();
    tenant = await createTestTenant(harness.app);
    const created = await createTestAgent(tenant.tenantId, tenant.userId);
    apiKey = created.apiKey;
    const tool = await createSsrfBlockedTool(tenant.tenantId, `chaos-tool-${Date.now()}`);
    toolName = tool.name;
    toolId = tool.id;
    await permissionService.assignPermission(tenant.tenantId, { agentId: created.agent.id, toolId: tool.id });
  }, 30_000);

  afterAll(async () => {
    const drainResult = await drainAuditQueueAndCloseWorker(harness, 30_000);
    console.log(`[chaos-test] audit drain: ${drainResult.drained ? "fully drained" : `TIMED OUT, ${drainResult.residualDepth} residual`}`);

    await cleanupTenant(tenant.tenantId).catch(() => { });
    await stopFullSystem(harness);
    process.off("unhandledRejection", onUnhandled);
    process.off("uncaughtException", onUnhandled);
    expect(unhandled).toHaveLength(0);
  }, 45_000);

  describe("Postgres — severed main-pool backend mid-request (Decision 8.84, Finding F1/F3)", () => {
    it("GATE — an in-flight tools/call whose main-pool query gets killed surfaces -32002, NEVER -32603 or -32004; unaffected concurrent calls still succeed", async () => {
      const BURST = 40;
      const calls = Array.from({ length: BURST }, (_, i) => callTool(harness.app, apiKey, toolName, `chaos-pg-${i}`));

      let totalKilled = 0;
      for (let i = 0; i < 15; i++) {
        try {
          totalKilled += await killAllMainPoolBackends();
        } catch (err) {
          console.warn(`[chaos-test] kill-loop iteration ${i} hit a transient error (expected occasionally):`, err);
        }
        await new Promise((r) => setTimeout(r, 5));
      }

      const responses = await Promise.all(calls);
      const codes = responses.map((r) => r.error?.code);

      // Decision 8.95 — log reason-level tally breakdown for visibility
      const reasonTally = responses.reduce<Record<string, number>>((acc, r) => {
        const key = r.error?.data?.reason ?? r.error?.data?.detail?.slice(0, 30) ?? `code:${r.error?.code}`;
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {});
      console.log("[chaos-test] -32002 reason breakdown:", reasonTally);

      expect(codes.every((c) => c === -32008 || c === -32002)).toBe(true);
      expect(codes).not.toContain(-32603);
      expect(codes).not.toContain(-32004);

      if (totalKilled > 0) {
        expect(codes.filter((c) => c === -32002).length).toBeGreaterThan(0);
      }
    }, 30_000);

    it("GATE — Prisma's pool self-heals with no manual intervention: a request fired AFTER the chaos succeeds normally", async () => {
      const res = await callTool(harness.app, apiKey, toolName, "chaos-pg-recovery");
      expect(res.error?.code).toBe(-32008);
    }, 10_000);
  });

  describe("Redis (rateLimiterRedis) — real disconnect mid-tool-call (Decision 8.85, Finding F4)", () => {
    it("GATE — a REAL disconnect reproduces the same bounded fail-open-then-fail-closed breaker sequence Week 3's own mocked-rejection tests already proved", async () => {
      const breaker = getRateLimiterBreaker();
      breaker.reset();
      disconnectRateLimiterRedis();

      const results: Array<number | undefined> = [];
      for (let i = 0; i < 5; i++) {
        const res = await callTool(harness.app, apiKey, toolName, `chaos-redis-${i}`);
        results.push(res.error?.code);
      }

      const firstDegradedIndex = results.findIndex((c) => c === -32002);
      expect(firstDegradedIndex).toBeGreaterThanOrEqual(0);
      expect(results.slice(0, firstDegradedIndex).every((c) => c === -32008)).toBe(true);
      expect(results.slice(firstDegradedIndex).every((c) => c === -32002)).toBe(true);
      expect(results).not.toContain(-32001);
    }, 15_000);

    it("GATE — an explicit reconnect restores normal operation once the breaker's cooldown elapses", async () => {
      await reconnectRateLimiterRedis();

      await waitFor(async () => {
        const res = await callTool(harness.app, apiKey, toolName, `chaos-redis-recovery-${Date.now()}`);
        expect(res.error?.code).toBe(-32008);
      }, 25_000);

      getRateLimiterBreaker().reset();
    }, 30_000);
  });

  describe("WS subscriber — real disconnect mid-session (extends Week 7 Day 6 GATE 13)", () => {
    it("GATE — an existing viewer survives the outage; /health degrades ONLY observabilityStream (fault isolation); a NEW event resumes flowing once reconnected", async () => {
      const ticketRes = await harness.app.inject({
        method: "POST", url: "/api/observability/ticket",
        headers: { Authorization: `Bearer ${tenant.accessToken}` },
      });
      const { ticket } = JSON.parse(ticketRes.body);
      const ws = new WsClient(`ws://127.0.0.1:${harness.port}/observability/stream?ticket=${ticket}`);
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", reject);
      });
      const connectedFrame = await new Promise<any>((resolve) => ws.once("message", (d) => resolve(JSON.parse(d.toString()))));
      expect(connectedFrame.type).toBe("connected");

      tenantEventSubscriber.disconnect();
      await new Promise((r) => setTimeout(r, 200));

      // Decision 8.94 — changed /healthcheck to /health
      const duringHealth = await harness.app.inject({ method: "GET", url: "/healthcheck" });
      const duringBody = JSON.parse(duringHealth.body);
      expect(duringHealth.statusCode).toBe(200);
      expect(duringBody.observabilityStream.healthy).toBe(false);
      expect(duringBody.rateLimiter.healthy).toBe(true);
      expect(ws.readyState).toBe(WsClient.OPEN);

      await tenantEventSubscriber.connect();
      await new Promise((r) => setTimeout(r, 200));

      const eventPromise = new Promise<any>((resolve) => ws.once("message", (d) => resolve(JSON.parse(d.toString()))));
      await callTool(harness.app, apiKey, toolName, "chaos-ws-recovery");
      const frame = await eventPromise;
      expect(frame.type).toBe("event");

      ws.close();
    }, 20_000);
  });

  describe("Audit worker — killed WHILE HOLDING THE LOCK (Decision 8.93)", () => {
    it("GATE — a real, MCP-generated job is recovered via BullMQ's own stalled-job detection, proven by the 'stalled' event, not by row count alone", async () => {
      const LOCK_DURATION_MS = 500;
      const STALL_INTERVAL_MS = 500;

      // ROOT-CAUSE FIX (not a timing band-aid): drain the queue via the
      // harness's still-running, unaffected steady-state worker BEFORE
      // closing it. Without this, backlog left over from the Postgres/
      // Redis/WS chaos tests earlier in this file — all sharing this
      // same tenant and the same global `audit` queue — can make
      // flakyWorker's *first* "active" event fire for a STALE job
      // instead of the one this test triggers below. In that failure
      // mode the target job is simply picked up normally later (no
      // stall involved), the row-count assertion still passes, and
      // stalledJobIds correctly stays empty — because no stall
      // genuinely happened for THIS job.
      const preDrain = await drainAuditQueueAndCloseWorker(harness, 15_000);
      console.log(
        `[chaos-test] pre-crash drain: ${preDrain.drained ? "fully drained" : `TIMED OUT, ${preDrain.residualDepth} residual`}`
      );
      // Fail loudly here, not downstream as mystery flakiness in the
      // assertion that actually matters.
      expect(preDrain.drained).toBe(true);

      const beforeCount = await auditPrisma.auditEvent.count({
        where: { tenantId: tenant.tenantId, eventType: "TOOL_INVOCATION" },
      });

      const flakyConnection = redis.duplicate();
      flakyConnection.on("error", () => { });
      const flakyWorker = createAuditWorker({
        connection: flakyConnection,
        lockDuration: LOCK_DURATION_MS,
        stalledInterval: STALL_INTERVAL_MS,
      });
      flakyWorker.on("error", () => { });

      const crashedWhileHoldingLock = new Promise<void>((resolve) => {
        // Safe to use .once() again — the queue is GUARANTEED empty at
        // this point, so the FIRST "active" event can only ever be for
        // the ONE job triggered below.
        flakyWorker.once("active", (job) => {
          console.log(`[chaos-test] flakyWorker claimed job ${job.id} (${job.name}) — severing its connection now`);
          flakyConnection.disconnect();
          resolve();
        });
      });

      const triggerPromise = callTool(
        harness.app, apiKey, toolName, `chaos-audit-single-${Date.now()}`
      );

      await crashedWhileHoldingLock;

      const queueEvents = new QueueEvents(auditQueue.name, {
        connection: redis.duplicate(),
      });
      await queueEvents.waitUntilReady();

      const stalledJobIds: string[] = [];
      queueEvents.on("stalled", ({ jobId }) => {
        stalledJobIds.push(jobId);
      });

      const freshWorker = createAuditWorker({
        lockDuration: LOCK_DURATION_MS,
        stalledInterval: STALL_INTERVAL_MS,
      });
      freshWorker.on("error", () => { });

      await waitFor(async () => {
        const currentCount = await auditPrisma.auditEvent.count({
          where: { tenantId: tenant.tenantId, eventType: "TOOL_INVOCATION" },
        });
        expect(currentCount).toBeGreaterThanOrEqual(beforeCount + 1);
        expect(stalledJobIds.length).toBeGreaterThanOrEqual(1);
      }, 15_000); // should now pass comfortably — see analysis above

      await triggerPromise.catch(() => { });
      await withTimeout(() => freshWorker.close(true), 3000).catch(() => { });
      await teardownIsolatedAuditWorker(flakyWorker, flakyConnection);
      await queueEvents.close().catch(() => { });

      harness.auditWorker = createAuditWorker();
    }, 30_000); // bumped slightly to cover the new up-front drain step
  });

  describe("Postgres chaos — identity resolution, cold cache (Week 9 Day 1, Decision 9.1/9.2, Finding F1/F2)", () => {
    it("GATE — a cold-cache identity resolution whose Postgres lookup is killed mid-flight surfaces -32002, NEVER -32603", async () => {
      // Deliberately mints N FRESH agents — one call each — so every
      // single request is a genuine cache-MISS forced through
      // resolveAgentIdentity()'s own Postgres fallback (Week 6 Day 2).
      // The ORIGINAL burst test (same agent, repeated calls) only
      // exercises this path for whichever calls happen to race the
      // FIRST successful resolution for that agent — non-deterministic
      // by construction. This test targets the specific path directly.
      const FRESH_AGENT_COUNT = 20;
      const freshAgents = await Promise.all(
        Array.from({ length: FRESH_AGENT_COUNT }, () => createTestAgent(tenant.tenantId, tenant.userId))
      );
      await Promise.all(
        freshAgents.map((a) =>
          permissionService.assignPermission(tenant.tenantId, { agentId: a.agent.id, toolId })
        )
      );

      const calls = freshAgents.map((a, i) => callTool(harness.app, a.apiKey, toolName, `chaos-identity-${i}`));

      let totalKilled = 0;
      for (let i = 0; i < 15; i++) {
        totalKilled += await killAllMainPoolBackends();
        await new Promise((r) => setTimeout(r, 5));
      }

      const responses = await Promise.all(calls);
      const codes = responses.map((r) => r.error?.code);

      expect(codes.every((c) => c === -32008 || c === -32002)).toBe(true);
      expect(codes).not.toContain(-32603);
      if (totalKilled > 0) {
        expect(codes.filter((c) => c === -32002).length).toBeGreaterThan(0);
      }
    }, 30_000);
  });
});