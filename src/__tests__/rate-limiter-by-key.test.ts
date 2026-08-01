import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { checkRateLimitByNameSpace } from "../lib/rate-limiter.js";

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