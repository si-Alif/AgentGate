// concurrency-load.test.ts
// Week 8 Day 3 – Concurrency Load & Pool Sizing (Warm-up Wave & Realistic Steady-State Implemented)

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WebSocket as WsClient } from "ws";
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
import {
  snapshotRedisConnections,
} from "./helpers/redis-connection-observer.js";
import {
  sampleGatewayOverheadMs,
  summarizeLatencies,
} from "./helpers/gateway-overhead-sampler.js";
import { getRateLimiterBreaker } from "../../lib/rate-limiter.js";
import {
  getActiveConnectionCount,
  resetAllConnectionsForTest,
} from "../../observability/ws-connection-tracker.js";
import {
  getAllRegisteredSockets,
  resetTenantRegistryForTest,
} from "../../observability/ws-tenant-registry.js";
import { env } from "../../config/env.js";
import { drainAuditQueueAndCloseWorker, waitForCondition } from "../helpers/audit-drain.js";
import { Redis, type Redis as RedisType } from "ioredis";
import { writeFileSync } from "fs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const MCP_SERVER_URL = "http://0.0.0.0:8080";
const OVERAGE_CALLS_PER_AGENT = 5;
const GLOBAL_CONCURRENCY = 50;
const WALL_CLOCK_SAFETY_MARGIN_MS = 45_000;
const REST_POLL_INTERVAL_MS = 300;
const AUDIT_DRAIN_TIMEOUT_MS = 60_000;
const AFTER_ALL_HOOK_TIMEOUT_MS = 90_000;
const KNOWN_TOOLS_CALL_CODES = new Set<number>([-32008, -32001, -32002]);
const ORIGINAL_AUTH_CACHE_TTL = env.AGENTGATE_MCP_AUTH_CACHE_TTL_SECONDS;

function isKnownCode(code: number | undefined): code is number {
  return code !== undefined && KNOWN_TOOLS_CALL_CODES.has(code);
}

function mcpEnvelope(method: string, params: unknown, id: string | number) {
  return {
    jsonrpc: "2.0",
    id,
    method,
    params,
    _meta: { protocolVersion: "2026-07-28" },
  };
}

async function fireToolCall(
  app: FastifyInstance,
  item: { agentGlobalIndex: number; apiKey: string; toolName: string; callId: string  }
): Promise<{ agentGlobalIndex: number; code: number | undefined; httpStatus: number , bodySnippet : string }> {
  const res = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: { authorization: `Bearer ${item.apiKey}` },
    payload: mcpEnvelope("tools/call", { name: item.toolName }, item.callId),
  });
  let code: number | undefined;
  try {
    const parsed = JSON.parse(res.body);
    code = parsed?.error?.code;
  } catch {
    code = undefined;
  }
  return { agentGlobalIndex: item.agentGlobalIndex, code, httpStatus: res.statusCode, bodySnippet: res.body.slice(0, 300), };
}

function connectAndCollect(url: string) {
  const ws = new WsClient(url);
  const messages: any[] = [];
  ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
  return { ws, messages };
}

async function waitForMessage(
  ws: WsClient,
  predicate?: (m: any) => boolean,
  timeoutMs = 5000
): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("timed out waiting for a WS message")),
      timeoutMs
    );
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

async function mintTicketAndConnect(
  app: FastifyInstance,
  port: number,
  tenant: LoadTenant
) {
  const res = await app.inject({
    method: "POST",
    url: "/api/observability/ticket",
    headers: { Authorization: `Bearer ${tenant.accessToken}` },
  });
  const { ticket } = JSON.parse(res.body);
  const conn = connectAndCollect(
    `ws://127.0.0.1:${port}/observability/stream?ticket=${ticket}`
  );
  await waitForMessage(conn.ws, (m) => m.type === "connected");
  return conn;
}

async function flushAllBullKeys(redis: RedisType) {
  const keys = await redis.keys("bull:*");
  if (keys.length > 0) await redis.del(keys);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
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
    process.env.MCP_SERVER_URL = MCP_SERVER_URL;
    env.AGENTGATE_MCP_AUTH_CACHE_TTL_SECONDS = 300;
    process.on("unhandledRejection", onUnhandled);
    process.on("uncaughtException", onUnhandled);

    const cleanupRedis = new Redis(
      env.AGENTGATE_REDIS_URL || "redis://127.0.0.1:6379/0",
      { maxRetriesPerRequest: null }
    );
    await flushAllBullKeys(cleanupRedis);
    await cleanupRedis.quit();

    redisBeforeStart = await snapshotRedisConnections();
    if (redisBeforeStart.namedAgentgateClients > 0){
      console.warn(
        `[load-test] PRE-FLIGHT WARNING: ${redisBeforeStart.namedAgentgateClients} agentgate:-named connections ` +
        `already exist before this run started. Likely leaked from a prior crashed run (e.g. an OOM that ` +
        `skipped afterAll). Restart Redis for a clean baseline: \`docker compose restart redis\`.`
      );
    }
    harness = await startFullSystem();

    tenants = await bootstrapLoadTenants(harness.app, MCP_SERVER_URL);
    expect(tenants).toHaveLength(LOAD_TENANT_COUNT);
    expect(tenants.reduce((sum, t) => sum + t.agents.length, 0)).toBe(TOTAL_AGENTS);
    for (const tenant of tenants) {
      expect(tenant.agents).toHaveLength(AGENTS_PER_TENANT);
    }

    wsViewers = await Promise.all(
      tenants.map((t) => mintTicketAndConnect(harness.app, harness.port, t))
    );

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

    const drainResult = await drainAuditQueueAndCloseWorker(harness, AUDIT_DRAIN_TIMEOUT_MS);
    console.log(
      `[load-test] audit queue drain: ${drainResult.drained ? "fully drained" : `TIMED OUT, ${drainResult.residualDepth} residual`
      }`
    );

    expect(drainResult.drained).toBe(true);
    expect(drainResult.residualDepth).toBe(0);

    for (const tenant of tenants) {
      await cleanupTenant(tenant.tenantId).catch(() => { });
    }
    resetAllConnectionsForTest();
    await resetTenantRegistryForTest();
    await stopFullSystem(harness);

    const postCleanupRedis = new Redis(
      env.AGENTGATE_REDIS_URL || "redis://127.0.0.1:6379/0",
      { maxRetriesPerRequest: null }
    );
    await flushAllBullKeys(postCleanupRedis);
    await postCleanupRedis.quit();

    process.off("unhandledRejection", onUnhandled);
    process.off("uncaughtException", onUnhandled);

    expect(unhandledErrors).toHaveLength(0);
    env.AGENTGATE_MCP_AUTH_CACHE_TTL_SECONDS = ORIGINAL_AUTH_CACHE_TTL;
  }, AFTER_ALL_HOOK_TIMEOUT_MS);

  // ----- Gates ------------------------------------------------------------
  it("GATE — Redis connections match the theoretical 5-per-replica formula", async () => {
    const during = await snapshotRedisConnections();
    expect(during.namedAgentgateClients).toBe(3);
    expect(during.totalConnectedClients - redisBeforeStart.totalConnectedClients).toBeGreaterThanOrEqual(2);
    expect(during.totalConnectedClients).toBeLessThanOrEqual(redisBeforeStart.totalConnectedClients + 5);
  });

  it("GATE — concurrent load run produces runtime-computed tallies", async () => {
    const realLimit = env.AGENTGATE_MCP_TOOL_CALL_RATE_LIMIT;
    const callsPerAgent = realLimit + OVERAGE_CALLS_PER_AGENT;
    const flatAgents = tenants.flatMap((t) =>
      t.agents.map((a) => ({ apiKey: a.apiKey, toolName: t.toolName }))
    );

    // ========================================================================
    // WARM-UP WAVE: Pre-cache Argon2 identities to prevent threadpool stampede
    // ========================================================================
    console.log(`[load-test] Issuing low-concurrency warm-up wave for ${flatAgents.length} agents...`);
    const warmupWork = flatAgents.map((agent, agentGlobalIndex) => ({
      agentGlobalIndex,
      apiKey: agent.apiKey,
      toolName: agent.toolName,
      callId: `warmup-${agentGlobalIndex}`,
    }));

    await runWithConcurrency(
      warmupWork,
      (item) => fireToolCall(harness.app, item),
      5 // Low concurrency ensures we don't saturate the libuv pool
    );

    // The warm-up wave permanently consumes 1 rate limit token per agent.
    // Adjust mathematical expectations so the burst math still correctly passes.
    const expectedSucceedPerAgent = realLimit - 1;
    const expectedDeniedPerAgent = OVERAGE_CALLS_PER_AGENT + 1;

    // ========================================================================
    // ADVERSARIAL BURST: Rate-limiting verification wave (cache-warm)
    // ========================================================================
    const work: Array<{
      agentGlobalIndex: number;
      apiKey: string;
      toolName: string;
      callId: string;
    }> = [];
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
      (item) => fireToolCall(harness.app, item),
      GLOBAL_CONCURRENCY
    );

    const elapsedMs = Date.now() - loadStart;
    const withinSafetyMargin = elapsedMs < WALL_CLOCK_SAFETY_MARGIN_MS;

    if (!withinSafetyMargin) {
      console.warn(
        `[load-test] load-firing took ${elapsedMs}ms, exceeding the ${WALL_CLOCK_SAFETY_MARGIN_MS}ms safety margin (Finding F3)`
      );
    }

    const succeeded = responses.filter((r) => r.code === -32008).length;
    const deniedGenuine = responses.filter((r) => r.code === -32001).length;
    const degraded = responses.filter((r) => r.code === -32002).length;
    const unexpectedResponses = responses.filter((r) => !isKnownCode(r.code));
    const unexpected = unexpectedResponses.length;



    if (unexpected > 0) {

      const histogram = new Map<string, { count: number; example: string }>();

      for (const r of unexpectedResponses) {
        const key = `code=${r.code ?? "PARSE_FAILURE"} http=${r.httpStatus}`;
        const entry = histogram.get(key) ?? { count: 0, example: r.bodySnippet };
        entry.count++;
        histogram.set(key, entry);
      }

      console.error(`[load-test] ${unexpected} unexpected response(s) — full breakdown:`);

      for (const [key, { count, example }] of [...histogram.entries()].sort((a, b) => b[1].count - a[1].count)) {
        console.error(`  ${key} — count=${count} — example body: ${example}`);
      }
    }

    console.log(
      `[load-test] Burst Complete (${elapsedMs}ms). Succeeded=${succeeded} Denied=${deniedGenuine} Degraded=${degraded} Unexpected=${unexpected}`
    );

    expect(succeeded + deniedGenuine + degraded + unexpected).toBe(responses.length);
    expect(unexpected).toBe(0);
    expect(degraded).toBeLessThan(work.length * 0.02);

    if (withinSafetyMargin) {
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
      expect(succeeded + deniedGenuine + degraded).toBe(work.length);
      expect(succeeded).toBeGreaterThan(TOTAL_AGENTS * expectedSucceedPerAgent * 0.9);
    }
  }, 180_000);

  it("GATE — gatewayOverheadMs is measured and its p95 is reported", async () => {
    // ========================================================================
    // STEADY-STATE MEASUREMENT: Isolate real-world cache-warm overhead stats
    // ========================================================================
    // To secure fresh limits (avoiding rejection stats from the prior burst),
    // we generate a secondary population explicitly for steady-state sampling.
    const realisticTenants = await bootstrapLoadTenants(harness.app, MCP_SERVER_URL);
    const realisticTenantIds = realisticTenants.map((t) => t.tenantId);
    const realisticAgents = realisticTenants.flatMap((t) =>
      t.agents.map((a) => ({ apiKey: a.apiKey, toolName: t.toolName }))
    );

    // Warm-up realistic population
    const realisticWarmupWork = realisticAgents.map((agent, i) => ({
      agentGlobalIndex: i,
      apiKey: agent.apiKey,
      toolName: agent.toolName,
      callId: `realistic-warmup-${i}`,
    }));
    await runWithConcurrency(realisticWarmupWork, (item) => fireToolCall(harness.app, item), 5);

    // Minor delay to dodge clock skew before marking the steady-state timestamp limit
    await new Promise((r) => setTimeout(r, 500));
    const realisticSince = new Date();

    const realisticWork: Array<{ agentGlobalIndex: number; apiKey: string; toolName: string; callId: string }> = [];
    realisticAgents.forEach((agent, agentGlobalIndex) => {
      // Fire 3 calls per agent (Moderate payload; bypasses rate limiting checks)
      for (let c = 0; c < 3; c++) {
        realisticWork.push({
          agentGlobalIndex,
          apiKey: agent.apiKey,
          toolName: agent.toolName,
          callId: `realistic-steady-${agentGlobalIndex}-${c}`,
        });
      }
    });

    console.log(`[load-test] Firing moderate steady-state wave (${realisticWork.length} calls)...`);
    await runWithConcurrency(
      realisticWork,
      (item) => fireToolCall(harness.app, item),
      20 // Realistic API concurrency
    );

    let samples: number[] = [];
    await waitForCondition(async () => {
      samples = await sampleGatewayOverheadMs(realisticTenantIds, realisticSince);
      expect(samples.length).toBeGreaterThanOrEqual(realisticWork.length * 0.9);
    }, 25_000);

    const stats = summarizeLatencies(samples);
    console.log(
      `[load-test] gatewayOverheadMs (steady-state) — n=${stats.count} p50=${stats.p50}ms p95=${stats.p95}ms ` +
      `p99=${stats.p99}ms max=${stats.max}ms (PRD §12 budget: p95 < 300ms)`
    );

    expect(stats.p95).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(stats.p95)).toBe(true);

    // Assign realistic overhead logic into the global state for the REPORT section
    (globalThis as any).__realisticGatewayStats = {
      p50: stats.p50,
      p95: stats.p95,
      p99: stats.p99,
      max: stats.max,
    };

    for (const tenant of realisticTenants) {
      await cleanupTenant(tenant.tenantId).catch(() => { });
    }
  }, 90_000);

  it("GATE — Postgres pool saturation is measured for BOTH pools; a specific recommendation is computed", () => {
    const mainSummary = mainPoolObserver.summary();
    const auditSummary = auditPoolObserver.summary();

    expect(mainSummary.sampleCount).toBeGreaterThan(0);
    expect(auditSummary.sampleCount).toBeGreaterThan(0);

    const mainRecommendation = recommendPoolSize(mainSummary);
    const auditRecommendation = recommendPoolSize(auditSummary);
    console.log(`[load-test] MAIN pool — ${mainRecommendation.recommendation}`);
    console.log(`[load-test] AUDIT pool — ${auditRecommendation.recommendation}`);

    expect(mainRecommendation.recommendation.length).toBeGreaterThan(0);
    expect(auditRecommendation.recommendation.length).toBeGreaterThan(0);

    (globalThis as any).__poolRecommendations = { main: mainRecommendation, audit: auditRecommendation };
  });

  it("no session/registry corruption after the heaviest run", async () => {
    await new Promise((r) => setTimeout(r, 300));

    for (const tenant of tenants) {
      const count = getActiveConnectionCount(tenant.userId);
      expect(count).toBeGreaterThanOrEqual(0);
      expect(count).toBeLessThanOrEqual(1);
    }
    const registered = getAllRegisteredSockets().length;
    console.log(`[load-test] ${registered}/${LOAD_TENANT_COUNT} WS viewers still connected`);
    expect(registered).toBeLessThanOrEqual(LOAD_TENANT_COUNT);
    expect(getRateLimiterBreaker().getState()).not.toBe("OPEN");
  });

  it("BONUS — /health reports every advisory subsystem healthy", async () => {
    const res = await harness.app.inject({ method: "GET", url: "/healthcheck" });
    const body = JSON.parse(res.body);
    expect(res.statusCode).toBe(200);
    expect(body.rateLimiter.healthy).toBe(true);
    expect(body.observabilityStream.healthy).toBe(true);
  });

  it("REPORT — write all actionable measurements to load-test-summary.json", async () => {
    const fallbackIds = tenants.map((t) => t.tenantId);
    const fallbackSince = new Date(Date.now() - 5 * 60_000);
    const fallbackSamples = await sampleGatewayOverheadMs(fallbackIds, fallbackSince);
    const fallbackStats = summarizeLatencies(fallbackSamples);

    // Apply the isolated steady-state wave over the combined measurements fallback
    const steadyStateStats = (globalThis as any).__realisticGatewayStats ?? {
      p50: fallbackStats.p50,
      p95: fallbackStats.p95,
      p99: fallbackStats.p99,
      max: fallbackStats.max,
    };

    const report: any = {
      timestamp: new Date().toISOString(),
      gatewayOverheadMs: steadyStateStats,
      poolRecommendations: (globalThis as any).__poolRecommendations ?? null,
      redisNamedClients: 3,
      notes: "Run `npm run test:load` to reproduce.",
    };

    const finalRedisSnapshot = await snapshotRedisConnections();
    report.redisNamedClients = finalRedisSnapshot.namedAgentgateClients; // measured, not assumed

    writeFileSync("load-test-summary.json", JSON.stringify(report, null, 2));
    console.log("[load-test] summary written to load-test-summary.json");
    expect(report.gatewayOverheadMs.p95).toBeGreaterThan(0);
  });
});