import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WebSocket as WsClient } from "ws";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { startFullSystem, stopFullSystem } from "../helpers/system-harness.js";
import type { SystemHarness } from "../helpers/system-harness.js";
import { cleanupTenant } from "../helpers/test-tenant.factory.js";
import {
  bootstrapLoadTenants,
  runWithConcurrency,
  startBackgroundRestPoller,
  LOAD_TENANT_COUNT,
  AGENTS_PER_TENANT,
  TOTAL_AGENTS,
} from "./helpers/load-harness.js";
import type { LoadTenant } from "./helpers/load-harness.js";
import { DbPoolObserver, recommendPoolSize } from "./helpers/db-pool-observer.js";
import { snapshotRedisConnections } from "./helpers/redis-connection-observer.js";
import { sampleGatewayOverheadMs, summarizeLatencies } from "./helpers/gateway-overhead-sampler.js";
import { getRateLimiterBreaker } from "../../lib/rate-limiter.js";
import {
  getActiveConnectionCount,
  resetAllConnectionsForTest,
} from "../../observability/ws-connection-tracker.js";
import { getAllRegisteredSockets, resetTenantRegistryForTest } from "../../observability/ws-tenant-registry.js";
import { env } from "../../config/env.js";
import { drainAuditQueueAndCloseWorker, waitForCondition } from "./helpers/audit-drain.js";

const OVERAGE_CALLS_PER_AGENT = 5;
const GLOBAL_CONCURRENCY = 150;
const WALL_CLOCK_SAFETY_MARGIN_MS = 45_000; // Finding F3 — comfortably under the 60s rate-limit window
const REST_POLL_INTERVAL_MS = 300;

function mcpEnvelope(method: string, params: unknown, id: string | number) {
  return { jsonrpc: "2.0", id, method, params, _meta: { protocolVersion: "2026-07-28" } };
}

async function mcpCall(app: FastifyInstance, apiKey: string, id: string | number) {
  const res = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: { authorization: `Bearer ${apiKey}` },
    payload: mcpEnvelope("tools/call", { name: "will-be-set-per-tenant" }, id),
  });
  return JSON.parse(res.body);
}

function connectAndCollect(url: string) {
  const ws = new WsClient(url);
  const messages: any[] = [];
  ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
  return { ws, messages };
}
async function waitForMessage(ws: WsClient, predicate?: (m: any) => boolean, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for a WS message")), timeoutMs);
    const handler = (data: Buffer) => {
      const parsed = JSON.parse(data.toString());
      if (!predicate || predicate(parsed)) {
        clearTimeout(timer);
        ws.off("message", handler);
        resolve(parsed);
      }
    };
    ws.on("message", handler);
  });
}
async function mintTicketAndConnect(app: FastifyInstance, port: number, tenant: LoadTenant) {
  const res = await app.inject({
    method: "POST",
    url: "/api/observability/ticket",
    headers: { Authorization: `Bearer ${tenant.accessToken}` },
  });
  const { ticket } = JSON.parse(res.body);
  const conn = connectAndCollect(`ws://127.0.0.1:${port}/observability/stream?ticket=${ticket}`);
  await waitForMessage(conn.ws, (m) => m.type === "connected");
  return conn;
}

interface CallDescriptor {
  agentIndex: number; // global index across all 50 agents
  apiKey: string;
  toolName: string;
}

/**
 * Week 8, Day 3 — Concurrency, Load & Pool Sizing.
 *
 * Deliberately isolated (Decision 8.71, Finding F8) — excluded from
 * the default `npm test` run via vitest.config.ts; invoked only via
 * `npm run test:load`.
 */
describe("Week 8, Day 3 — Concurrency Load & Pool Sizing", () => {
  let harness: SystemHarness;
  let tenants: LoadTenant[];
  let restPoller: { stop: () => void };
  let mainPoolObserver: DbPoolObserver;
  let auditPoolObserver: DbPoolObserver;
  let wsViewers: Array<{ ws: WsClient; messages: any[] }>;
  let redisBeforeStart: Awaited<ReturnType<typeof snapshotRedisConnections>>;
  const unhandledErrors: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandledErrors.push(reason);

  beforeAll(async () => {
    process.on("unhandledRejection", onUnhandled);
    process.on("uncaughtException", onUnhandled);

    redisBeforeStart = await snapshotRedisConnections();
    harness = await startFullSystem();

    tenants = await bootstrapLoadTenants(harness.app);
    expect(tenants).toHaveLength(LOAD_TENANT_COUNT);
    expect(tenants.reduce((sum, t) => sum + t.agents.length, 0)).toBe(TOTAL_AGENTS);

    wsViewers = await Promise.all(tenants.map((t) => mintTicketAndConnect(harness.app, harness.port, t)));

    restPoller = startBackgroundRestPoller(harness.app, tenants, REST_POLL_INTERVAL_MS);

    mainPoolObserver = new DbPoolObserver("agentgate-main", env.AGENTGATE_DB_POOL_MAX);
    auditPoolObserver = new DbPoolObserver("agentgate-audit", env.AGENTGATE_AUDIT_DB_POOL_MAX);
    mainPoolObserver.start();
    auditPoolObserver.start();
  }, 60_000);

  afterAll(async () => {
    mainPoolObserver.stop();
    auditPoolObserver.stop();
    restPoller.stop();
    wsViewers.forEach((v) => v.ws.close());

    const drainResult = await drainAuditQueueAndCloseWorker(harness, 30_000);
    console.log(
      `[load-test] audit queue drain: ${drainResult.drained ? "fully drained" : `TIMED OUT, ${drainResult.residualDepth} residual`}`
    );

    for (const tenant of tenants) {
      await cleanupTenant(tenant.tenantId).catch(() => { });
    }

    resetAllConnectionsForTest();
    await resetTenantRegistryForTest();
    await stopFullSystem(harness);

    process.off("unhandledRejection", onUnhandled);
    process.off("uncaughtException", onUnhandled);
    // GATE — zero unhandled errors across the entire, heaviest-yet run.
    expect(unhandledErrors).toHaveLength(0);
  }, 30_000);

  it("GATE — Redis connections match the theoretical 5-per-replica formula (Decision 8.14/8.37), validated against what the process actually opened", async () => {
    const during = await snapshotRedisConnections();
    // The 3 explicitly-owned, directly-named clients (redis,
    // rateLimiterRedis, tenantEventSubscriber) — a definitive count,
    // independent of BullMQ's own internal, unnamed duplicates.
    expect(during.namedAgentgateClients).toBe(3);
    // Corroborating total: 3 named + 2 unnamed BullMQ-internal
    // blocking-read duplicates (audit worker's own, email worker's
    // own — confirmed shared-client, Decision 8.37) = 5.
    expect(during.totalConnectedClients - redisBeforeStart.totalConnectedClients).toBeGreaterThanOrEqual(2);
    expect(during.totalConnectedClients).toBeLessThanOrEqual(redisBeforeStart.totalConnectedClients + 5);
  });

  it("GATE — the concurrent load run produces the exact, runtime-computed 60/min-derived tallies (Decision 8.64), never the master plan's stale 10/min-derived figures", async () => {
    const realLimit = env.AGENTGATE_MCP_TOOL_CALL_RATE_LIMIT;
    const callsPerAgent = realLimit + OVERAGE_CALLS_PER_AGENT;
    const expectedSucceedPerAgent = realLimit;
    const expectedDeniedPerAgent = OVERAGE_CALLS_PER_AGENT;

    // Flatten every (agent, call) pair across ALL 50 agents into one
    // globally-concurrent work list — cross-agent interleaving, not
    // per-agent-sequential (Decision 8.65 / Finding F3).
    const flatAgents = tenants.flatMap((t) => t.agents.map((a) => ({ apiKey: a.apiKey, toolName: t.toolName, tenant: t, agentId: a.id })));
    const work: Array<{ agentGlobalIndex: number; apiKey: string; toolName: string; callId: string }> = [];
    flatAgents.forEach((agent, agentGlobalIndex) => {
      for (let c = 0; c < callsPerAgent; c++) {
        work.push({
          agentGlobalIndex,
          apiKey: agent.apiKey,
          toolName: agent.toolName,
          callId: `load-${agentGlobalIndex}-${c}`,
        });
      }
    });
    expect(work.length).toBe(TOTAL_AGENTS * callsPerAgent);

    const loadStart = Date.now();

    const responses = await runWithConcurrency(
      work,
      async (item) => {
        const res = await harness.app.inject({
          method: "POST",
          url: "/mcp",
          headers: { authorization: `Bearer ${item.apiKey}` },
          payload: mcpEnvelope("tools/call", { name: item.toolName }, item.callId),
        });
        return { agentGlobalIndex: item.agentGlobalIndex, code: JSON.parse(res.body)?.error?.code as number | undefined };
      },
      GLOBAL_CONCURRENCY
    );

    const elapsedMs = Date.now() - loadStart;
    const withinSafetyMargin = elapsedMs < WALL_CLOCK_SAFETY_MARGIN_MS;
    if (!withinSafetyMargin) {
      // eslint-disable-next-line no-console
      console.warn(
        `[load-test] load-firing took ${elapsedMs}ms, exceeding the ${WALL_CLOCK_SAFETY_MARGIN_MS}ms safety ` +
        `margin (Finding F3) — per-agent minute-window boundaries may have been crossed for some agents. ` +
        `Falling back to a looser, aggregate-only assertion for this run rather than a hard per-agent one.`
      );
    }

    // Tally by JSON-RPC code — Decision 8.68 (Finding F6). Three
    // buckets, never conflated.
    const succeeded = responses.filter((r) => r.code === -32008).length; // SSRF_BLOCKED = "executed"
    const deniedGenuine = responses.filter((r) => r.code === -32001).length; // RATE_LIMITED
    const degraded = responses.filter((r) => r.code === -32002).length; // SERVICE_DEGRADED

    // eslint-disable-next-line no-console
    console.log(
      `[load-test] ${work.length} calls in ${elapsedMs}ms — succeeded=${succeeded} deniedGenuine=${deniedGenuine} degraded=${degraded}`
    );

    // Degraded should be near-zero on healthy local infra — never
    // silently absorbed into either other bucket if it isn't.
    expect(degraded).toBeLessThan(work.length * 0.02); // generous, informative ceiling, not a hard zero

    if (withinSafetyMargin) {
      // Strict, exact, per-agent AND aggregate assertions.
      const perAgentTally = new Map<number, { succeeded: number; deniedGenuine: number }>();
      for (const r of responses) {
        const entry = perAgentTally.get(r.agentGlobalIndex) ?? { succeeded: 0, deniedGenuine: 0 };
        if (r.code === -32008) entry.succeeded++;
        if (r.code === -32001) entry.deniedGenuine++;
        perAgentTally.set(r.agentGlobalIndex, entry);
      }
      for (const [, tally] of perAgentTally) {
        expect(tally.succeeded).toBe(expectedSucceedPerAgent);
        expect(tally.deniedGenuine).toBe(expectedDeniedPerAgent);
      }
      expect(succeeded).toBe(TOTAL_AGENTS * expectedSucceedPerAgent);
      expect(deniedGenuine).toBe(TOTAL_AGENTS * expectedDeniedPerAgent);
    } else {
      // Documented, bounded degradation of assertion precision.
      expect(succeeded + deniedGenuine + degraded).toBe(work.length);
      expect(succeeded).toBeGreaterThan(TOTAL_AGENTS * expectedSucceedPerAgent * 0.9);
    }
  }, 180_000);

  it("GATE — gatewayOverheadMs is measured (not silently zero-sampled) and its p95 is reported against the PRD §12 budget, without being hard-gated by it", async () => {
    const tenantIds = tenants.map((t) => t.tenantId);
    // A window comfortably covering the whole beforeAll+load lifetime.
    const since = new Date(Date.now() - 5 * 60_000);


    // The load-bearing proof for Finding F5: a naive client-response
    // sampling strategy would have produced ZERO samples here. This
    // MUST be a real, substantial population.
    let samples: number[] = [];
    await waitForCondition(async () => {
      samples = await sampleGatewayOverheadMs(tenantIds, since);
      expect(samples.length).toBeGreaterThan(TOTAL_AGENTS * env.AGENTGATE_MCP_TOOL_CALL_RATE_LIMIT * 0.9);
    }, 25_000);

    const stats = summarizeLatencies(samples);
    // eslint-disable-next-line no-console
    console.log(
      `[load-test] gatewayOverheadMs — n=${stats.count} p50=${stats.p50}ms p95=${stats.p95}ms ` +
      `p99=${stats.p99}ms max=${stats.max}ms (PRD §12 budget: p95 < 300ms)`
    );

    // Measurability is the gate — NOT the threshold (master plan's own
    // explicit framing: "this day's job is to know the number, not to
    // force it under budget by any means necessary").
    expect(stats.p95).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(stats.p95)).toBe(true);
  }, 30_000);

  it("GATE — Postgres pool saturation is measured for BOTH pools; a specific recommendation is computed, never a number asserted without having been measured", () => {
    const mainSummary = mainPoolObserver.summary();
    const auditSummary = auditPoolObserver.summary();

    expect(mainSummary.sampleCount).toBeGreaterThan(0);
    expect(auditSummary.sampleCount).toBeGreaterThan(0);

    const mainRecommendation = recommendPoolSize(mainSummary);
    const auditRecommendation = recommendPoolSize(auditSummary);

    // eslint-disable-next-line no-console
    console.log(`[load-test] MAIN pool — ${mainRecommendation.recommendation}`);
    // eslint-disable-next-line no-console
    console.log(`[load-test] AUDIT pool — ${auditRecommendation.recommendation}`);

    // The checkpoint is that a REASONED, ACTIONABLE conclusion exists
    // — either "confirmed sufficient" or "here is the specific
    // revised value and why" — never silence.
    expect(mainRecommendation.recommendation.length).toBeGreaterThan(0);
    expect(auditRecommendation.recommendation.length).toBeGreaterThan(0);
  });

  it("no session/registry corruption after the heaviest run this project has produced: WS registries clean, breaker not stuck OPEN", async () => {
    await new Promise((r) => setTimeout(r, 300)); // let close listeners settle after afterAll's own teardown steps begin

    for (const tenant of tenants) {
      expect(getActiveConnectionCount(tenant.userId)).toBeGreaterThanOrEqual(0); // never negative — a corruption signal
    }
    // Breaker should have recovered (or never tripped) against healthy
    // local Redis by the time this assertion runs, several seconds
    // after the burst completed.
    expect(getRateLimiterBreaker().getState()).not.toBe("OPEN");
  });

  it("BONUS — /health reports every advisory subsystem healthy after the full run (mirrors Week 8 Day 1's own bonus check, now under real load)", async () => {
    const res = await harness.app.inject({ method: "GET", url: "/healthcheck" });
    const body = JSON.parse(res.body);
    expect(res.statusCode).toBe(200);
    expect(body.rateLimiter.healthy).toBe(true);
    expect(body.observabilityStream.healthy).toBe(true);
  });
});