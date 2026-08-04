import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import { createApp } from "../app.js";
import {
  getRateLimiterBreaker,
  resetRateLimitKeyForTest,
} from "../lib/rate-limiter.js";
import * as rateLimiterModule from "../lib/rate-limiter.js";
import { prisma } from "../lib/prisma.js";
import { env } from "../config/env.js";

function registerPayload(overrides: Record<string, unknown> = {}) {
  return {
    tenantName: `Tenant ${crypto.randomUUID()}`,
    slug: `slug-${crypto.randomUUID()}`,
    ownerEmail: `${crypto.randomUUID()}@example.com`,
    password: "TestPassword123!",
    ...overrides,
  };
}

describe("Public-auth throttle — Week 8 Day 2, closing Finding W8-2", () => {
  let app: Awaited<ReturnType<typeof createApp>>;

  beforeEach(async () => {
    // 1. Freeze the clock strictly for Date (leaves setTimeout intact for Fastify)
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-05T12:00:00.000Z"));

    app = await createApp();
    await resetRateLimitKeyForTest("public-auth", "127.0.0.1:register-tenant");
    await resetRateLimitKeyForTest("public-auth", "127.0.0.1:register-user");
    await resetRateLimitKeyForTest("public-auth", "127.0.0.1:login");
    getRateLimiterBreaker().reset();
  });

  afterEach(async () => {
    await app.close();
    getRateLimiterBreaker().reset();

    // 2. Restore normal time passing
    vi.useRealTimers();
  });

  it("GATE — register-tenant is throttled: the (limit+1)th request in a minute returns 429", async () => {
    const limit = env.AGENTGATE_PUBLIC_AUTH_RATE_LIMIT;
    let last;
    for (let i = 0; i < limit + 1; i++) {
      last = await app.inject({ method: "POST", url: "/auth/register-tenant", payload: registerPayload() });
    }
    expect(last!.statusCode).toBe(429);
    expect(JSON.parse(last!.body).error).toBe("rate_limited");
  });

  it("GATE — login is throttled independently, via a burst of bad-credential attempts", async () => {
    const limit = env.AGENTGATE_PUBLIC_AUTH_RATE_LIMIT;
    let last;
    for (let i = 0; i < limit + 1; i++) {
      last = await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { email: "nobody@example.com", password: `guess-${i}` },
      });
    }
    expect(last!.statusCode).toBe(429);
  });

  it("GATE — register-tenant's bucket and login's bucket are fully INDEPENDENT (Decision 8.41 / Finding F4)", async () => {
    const limit = env.AGENTGATE_PUBLIC_AUTH_RATE_LIMIT;
    for (let i = 0; i < limit + 1; i++) {
      await app.inject({ method: "POST", url: "/auth/register-tenant", payload: registerPayload() });
    }
    // register-tenant is now exhausted for this IP. login must be UNAFFECTED.
    const loginRes = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "nobody@example.com", password: "whatever" },
    });
    expect(loginRes.statusCode).not.toBe(429); // 401 (bad credentials) or similar — never 429
  });

  it("GATE — a DEGRADED (breaker-open) result maps to 503, never 429, and the handler never runs (no silent bypass)", async () => {
    const spy = vi.spyOn(rateLimiterModule, "checkRateLimitByNameSpace").mockResolvedValue({
      allowed: false,
      remaining: 0,
      degraded: true,
    });

    const email = `degraded-${crypto.randomUUID()}@example.com`;
    const res = await app.inject({
      method: "POST",
      url: "/auth/register-tenant",
      payload: registerPayload({ ownerEmail: email }),
    });

    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).error).toBe("service_degraded");

    const created = await prisma.user.findUnique({ where: { email } });
    expect(created).toBeNull(); // proves the real handler never ran

    spy.mockRestore();
  });

  it("out-of-scope routes (GET /auth/verify-email) are never throttled by this mechanism", async () => {
    let anyRateLimited = false;
    for (let i = 0; i < env.AGENTGATE_PUBLIC_AUTH_RATE_LIMIT + 10; i++) {
      const res = await app.inject({ method: "GET", url: `/auth/verify-email?token=nonexistent-${i}` });
      if (res.statusCode === 429) anyRateLimited = true;
    }
    expect(anyRateLimited).toBe(false);
  });

  it("shares the SAME circuit breaker as every other coarse throttle — no new Redis connection, no new breaker instance", async () => {
    const breaker = getRateLimiterBreaker();
    breaker.reset();
    breaker.onFailure();
    breaker.onFailure();
    breaker.onFailure(); // trips OPEN

    const res = await app.inject({ method: "POST", url: "/auth/register-tenant", payload: registerPayload() });
    expect(res.statusCode).toBe(503);

    breaker.reset();
  });
});