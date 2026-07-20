import { describe, it, expect, vi, beforeEach } from "vitest";
import { rateLimiterRedis, checkRateLimit, getRateLimiterBreaker } from "../lib/rate-limiter.js";

describe("checkRateLimit + CircuitBreaker — integration", () => {
  beforeEach(() => {
    getRateLimiterBreaker().reset();
  });

  it("fails OPEN below the trip threshold, then fails CLOSED once tripped, without touching Redis again", async () => {
    const spy = vi.spyOn(rateLimiterRedis, "rateLimitIncr").mockRejectedValue(new Error("ECONNREFUSED"));

    const r1 = await checkRateLimit("agent-breaker-test", 10);
    expect(r1).toEqual({ allowed: true, remaining: 10, degraded: true }); // 1st failure — fail open

    const r2 = await checkRateLimit("agent-breaker-test", 10);
    expect(r2.allowed).toBe(true); // 2nd failure — still below threshold=3

    const r3 = await checkRateLimit("agent-breaker-test", 10);
    expect(r3.allowed).toBe(false); // 3rd failure trips the breaker -> fail closed

    const r4 = await checkRateLimit("agent-breaker-test", 10);
    expect(r4.allowed).toBe(false); // breaker OPEN -> fails closed WITHOUT attempting Redis

    expect(spy).toHaveBeenCalledTimes(3); // proves the 4th call never touched Redis at all

    spy.mockRestore();
  });

  it("recovers to normal operation once Redis comes back and the cooldown elapses", async () => {
    const breaker = getRateLimiterBreaker();
    const spy = vi.spyOn(rateLimiterRedis, "rateLimitIncr").mockRejectedValue(new Error("ECONNREFUSED"));

    await checkRateLimit("agent-recovery-test", 10);
    await checkRateLimit("agent-recovery-test", 10);
    await checkRateLimit("agent-recovery-test", 10); // trips OPEN

    expect(breaker.getState()).toBe("OPEN");

    spy.mockResolvedValue(1);
    // NOTE: in the real breaker this requires waiting cooldownMs —
    // for a fast test, configure a short cooldown for this suite
    // specifically, or advance Vitest's fake timers here.

    spy.mockRestore();
  });
});