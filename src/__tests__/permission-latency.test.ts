import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp } from "../app.js";
import { checkPermission } from "../lib/permission-engine.js";
import {
  createTestTenant,
  createTestAgent,
  createTestTool,
  cleanupTenant,
} from "./helpers/test-tenant.factory.js";

/**
 * Not an official PRD gate the way the <5ms Redis rate-limit target
 * is (PRD §12 only names the Redis side explicitly) — but by Week 6,
 * checkPermission()'s Postgres round trip and checkRateLimit()'s
 * Redis round trip both run SEQUENTIALLY in front of executeTool(),
 * inside the same 300ms p95 gateway-overhead budget. Measure it now,
 * same "measure, don't assume" discipline as the Redis-side bench.
 */
describe("checkPermission — latency (informal budget: p95 < 10ms, local Postgres)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await createApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("p95 latency stays comfortably under budget against local Postgres", async () => {
    const tenant = await createTestTenant(app);
    const agent = await createTestAgent(tenant.tenantId, tenant.userId);
    const tool = await createTestTool(tenant.tenantId);

    const samples: number[] = [];
    for (let i = 0; i < 200; i++) {
      const start = performance.now();
      await checkPermission(agent.agent.id, tool.id, tenant.tenantId);
      samples.push(performance.now() - start);
    }

    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor(samples.length * 0.95)] as number;
    // eslint-disable-next-line no-console
    console.log(`checkPermission p95 latency (local Postgres): ${p95.toFixed(2)}ms`);

    expect(p95).toBeLessThan(10);

    await cleanupTenant(tenant.tenantId);
  });
});