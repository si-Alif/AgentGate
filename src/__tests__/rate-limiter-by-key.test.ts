import { describe, it, expect , vi} from "vitest";
import crypto from "node:crypto";
import { checkRateLimitByNameSpace , checkRateLimitByKey , rateLimiterRedis } from "../lib/rate-limiter.js";
import * as rateLimiterModule from "../lib/rate-limiter.js";

describe("checkRateLimitByKey — namespace isolation", () => {
  it("the same identifier under different namespaces does not share a counter", async () => {
    const id = crypto.randomUUID();
    const a = await checkRateLimitByNameSpace("ns-a", id, 5);
    const b = await checkRateLimitByNameSpace("ns-b", id, 5);
    expect(a.remaining).toBe(4);
    expect(b.remaining).toBe(4); // NOT 3 — proves isolation, not a shared bucket
  });

  it("repeated calls under the SAME namespace+identifier do share a counter", async () => {
    const id = crypto.randomUUID();
    await checkRateLimitByNameSpace("ns-shared", id, 5);
    const second = await checkRateLimitByNameSpace("ns-shared", id, 5);
    expect(second.remaining).toBe(3);
  });

  it("degrades identically to checkRateLimit under a forced breaker trip (shared breaker)", async () => {
    // Not re-proving the breaker's own state machine (Week 3 already
    // does that exhaustively) — just confirming this new entry point
    // goes through the SAME breaker instance, not a separate one.
    const { getRateLimiterBreaker } = await import("../lib/rate-limiter.js");
    const breaker = getRateLimiterBreaker();
    breaker.reset();
    breaker.onFailure();
    breaker.onFailure();
    breaker.onFailure(); // trips OPEN
    const result = await checkRateLimitByNameSpace("ns-degraded", crypto.randomUUID(), 100);
    expect(result).toEqual({ allowed: false, remaining: 0, degraded: true });
    breaker.reset();
  });
});

describe("checkRateLimitByKey — Week 7 Day 5, Decision 7.61", () => {
  it("delegates to checkRateLimitByNameSpace with the dedicated 'audit-events-read' namespace", async () => {
    const spy = vi.spyOn(rateLimiterModule, "checkRateLimitByNameSpace");
    const key = crypto.randomUUID();
    await checkRateLimitByKey(key, 30);
    expect(spy).toHaveBeenCalledWith("audit-events-read", key, 30);
    spy.mockRestore();
  });

  it("GATE — produces a real Redis key under the new namespace, confirmed by direct inspection", async () => {
    const key = crypto.randomUUID();
    await checkRateLimitByKey(key, 30);
    const matches = await rateLimiterRedis.keys(`rate:audit-events-read:${key}:min:*`);
    expect(matches.length).toBe(1);
  });

  it("preserves exact concurrency-accuracy under this new namespace (regression of Week 3's own gate)", async () => {
    const key = crypto.randomUUID();
    const results = await Promise.all(Array.from({ length: 20 }, () => checkRateLimitByKey(key, 10)));
    expect(results.filter((r) => r.allowed).length).toBe(10);
    expect(results.filter((r) => !r.allowed).length).toBe(10);
  });

  it("surfaces degraded:true correctly (never silently coerced to a plain denial)", async () => {
    const breakerModule = await import("../lib/rate-limiter.js");
    const breaker = breakerModule.getRateLimiterBreaker();
    breaker.reset();
    breaker.onFailure();
    breaker.onFailure();
    breaker.onFailure(); // trips OPEN
    const result = await checkRateLimitByKey(crypto.randomUUID(), 100);
    expect(result).toEqual({ allowed: false, remaining: 0, degraded: true });
    breaker.reset();
  });
});