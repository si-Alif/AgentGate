import { describe, it, expect } from "vitest";
import {
  getRateLimiterHealth,
  getRateLimiterBreaker,
} from "../lib/rate-limiter.js";

describe("getRateLimiterHealth (Finding #11 fix)", () => {
  it("reports healthy=true and CLOSED when the breaker is fresh", () => {
    const breaker = getRateLimiterBreaker();
    breaker.reset();

    const health = getRateLimiterHealth();
    expect(health).toEqual({
      healthy: true,
      breakerState: "CLOSED",
    });
  });

  it("reports healthy=false and OPEN after the breaker trips", () => {
    const breaker = getRateLimiterBreaker();
    breaker.reset();

    breaker.onFailure();
    breaker.onFailure();
    breaker.onFailure();

    const health = getRateLimiterHealth();
    expect(health).toEqual({
      healthy: false,
      breakerState: "OPEN",
    });
  });

  it("reports healthy=true and HALF_OPEN after cooldown elapses", async () => {
    const breaker = getRateLimiterBreaker();
    breaker.reset();

    breaker.onFailure();
    breaker.onFailure();
    breaker.onFailure();
    expect(breaker.getState()).toBe("OPEN");

    await new Promise((r) => setTimeout(r, 20));
    (breaker as any).lastOpenedAt = Date.now() - 20_000;
    breaker.canAttempt(); // transitions to HALF_OPEN

    const health = getRateLimiterHealth();
    expect(health).toEqual({
      healthy: true,
      breakerState: "HALF_OPEN",
    });
  });

  it("returns to healthy=true and CLOSED after a successful recovery", async () => {
    const breaker = getRateLimiterBreaker();
    breaker.reset();

    breaker.onFailure();
    breaker.onFailure();
    breaker.onFailure();

    await new Promise((r) => setTimeout(r, 20));
    (breaker as any).lastOpenedAt = Date.now() - 20_000;
    breaker.canAttempt();
    breaker.onSuccess();

    const health = getRateLimiterHealth();
    expect(health).toEqual({
      healthy: true,
      breakerState: "CLOSED",
    });
  });
});