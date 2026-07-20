import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  checkRateLimit,
  getRateLimiterBreaker,
  rateLimiterRedis,
  getRateLimiterHealth,
} from "../lib/rate-limiter.js";

describe("checkRateLimit + CircuitBreaker — integration (Finding #1 fix)", () => {
  beforeEach(() => {
    getRateLimiterBreaker().reset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("fails OPEN below the trip threshold, then fails CLOSED once tripped, without touching Redis again", async () => {
    const spy = vi
      .spyOn(rateLimiterRedis, "rateLimitIncr")
      .mockRejectedValue(new Error("ECONNREFUSED"));

    const r1 = await checkRateLimit("agent-breaker-test", 10);
    expect(r1).toEqual({ allowed: true, remaining: 10, degraded: true }); // 1st failure — fail open

    const r2 = await checkRateLimit("agent-breaker-test", 10);
    expect(r2.allowed).toBe(true); // 2nd failure — still below threshold=3

    const r3 = await checkRateLimit("agent-breaker-test", 10);
    expect(r3.allowed).toBe(false); // 3rd failure trips OPEN → fail closed

    const r4 = await checkRateLimit("agent-breaker-test", 10);
    expect(r4.allowed).toBe(false); // breaker OPEN → fails closed WITHOUT Redis

    expect(spy).toHaveBeenCalledTimes(3); // proves the 4th call never touched Redis

    spy.mockRestore();
  });

  it("recovers through HALF_OPEN to CLOSED after Redis comes back (THE CRITICAL FIX)", async () => {
    const breaker = getRateLimiterBreaker();
    const spy = vi.spyOn(rateLimiterRedis, "rateLimitIncr");

    // Phase 1: Redis fails 3x → breaker trips OPEN
    spy.mockRejectedValue(new Error("ECONNREFUSED"));
    await checkRateLimit("agent-recovery", 10);
    await checkRateLimit("agent-recovery", 10);
    await checkRateLimit("agent-recovery", 10);
    expect(breaker.getState()).toBe("OPEN");

    // Phase 2: Advance past cooldown (15s)
    vi.advanceTimersByTime(16_000);

    // Phase 3: Redis works again → probe succeeds → CLOSED
    spy.mockResolvedValue(1);
    const result = await checkRateLimit("agent-recovery", 10);
    expect(result.degraded).toBe(false);
    expect(result.allowed).toBe(true);
    expect(breaker.getState()).toBe("CLOSED");

    // Phase 4: Subsequent calls work normally
    spy.mockResolvedValue(2);
    const result2 = await checkRateLimit("agent-recovery", 10);
    expect(result2.degraded).toBe(false);
    expect(result2.allowed).toBe(true);

    expect(spy).toHaveBeenCalledTimes(5); // 3 failures + 2 successes

    spy.mockRestore();
  });

  it("getRateLimiterHealth() reflects breaker state accurately", () => {
    const breaker = getRateLimiterBreaker();

    breaker.reset();
    expect(getRateLimiterHealth()).toEqual({
      healthy: true,
      breakerState: "CLOSED",
    });

    breaker.onFailure();
    breaker.onFailure();
    breaker.onFailure();
    expect(getRateLimiterHealth()).toEqual({
      healthy: false,
      breakerState: "OPEN",
    });
  });
});