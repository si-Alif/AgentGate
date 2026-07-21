import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  checkRateLimit,
  checkRateLimitByKey,
  getRateLimiterBreaker,
  rateLimiterRedis,
} from "../lib/rate-limiter.js";

describe("checkRateLimit + CircuitBreaker — integration (Finding #1 & #9 fix)", () => {
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
    expect(r1).toEqual({ allowed: true, remaining: 10, degraded: true });

    const r2 = await checkRateLimit("agent-breaker-test", 10);
    expect(r2.allowed).toBe(true);

    const r3 = await checkRateLimit("agent-breaker-test", 10);
    expect(r3.allowed).toBe(false);

    const r4 = await checkRateLimit("agent-breaker-test", 10);
    expect(r4.allowed).toBe(false);

    expect(spy).toHaveBeenCalledTimes(3);

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

    expect(spy).toHaveBeenCalledTimes(5);

    spy.mockRestore();
  });

  it("checkRateLimitByKey uses the same breaker and recovers correctly", async () => {
    const breaker = getRateLimiterBreaker();
    const spy = vi.spyOn(rateLimiterRedis, "rateLimitIncr");

    spy.mockRejectedValue(new Error("ECONNREFUSED"));
    await checkRateLimitByKey("custom-key-1", 10);
    await checkRateLimitByKey("custom-key-1", 10);
    await checkRateLimitByKey("custom-key-1", 10);
    expect(breaker.getState()).toBe("OPEN");

    vi.advanceTimersByTime(16_000);

    spy.mockResolvedValue(1);
    const result = await checkRateLimitByKey("custom-key-1", 10);
    expect(result.degraded).toBe(false);
    expect(breaker.getState()).toBe("CLOSED");

    spy.mockRestore();
  });
});