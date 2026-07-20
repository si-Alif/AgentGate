import { describe, it, expect } from "vitest";
import { CircuitBreaker } from "../lib/circuit-breaker.js";

describe("CircuitBreaker", () => {
  it("stays CLOSED and keeps attempting under the failure threshold", () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000 });
    breaker.onFailure();
    breaker.onFailure();
    expect(breaker.getState()).toBe("CLOSED");
    expect(breaker.canAttempt()).toBe(true);
  });

  it("trips OPEN exactly when the failure threshold is reached", () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000 });
    breaker.onFailure();
    breaker.onFailure();
    breaker.onFailure();
    expect(breaker.getState()).toBe("OPEN");
    expect(breaker.canAttempt()).toBe(false);
  });

  it("moves to HALF_OPEN and allows exactly one probe after the cooldown elapses", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 50 });
    breaker.onFailure();
    expect(breaker.canAttempt()).toBe(false);

    await new Promise((r) => setTimeout(r, 60));

    expect(breaker.canAttempt()).toBe(true);
    expect(breaker.getState()).toBe("HALF_OPEN");
  });

  it("a successful HALF_OPEN probe resets fully to CLOSED", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 50 });
    breaker.onFailure();
    await new Promise((r) => setTimeout(r, 60));
    breaker.canAttempt();
    breaker.onSuccess();
    expect(breaker.getState()).toBe("CLOSED");
  });

  it("a failed HALF_OPEN probe returns to OPEN and restarts the cooldown", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 50 });
    breaker.onFailure();
    await new Promise((r) => setTimeout(r, 60));
    breaker.canAttempt();
    breaker.onFailure();
    expect(breaker.getState()).toBe("OPEN");
    expect(breaker.canAttempt()).toBe(false);
  });

  it("a single success while CLOSED resets the consecutive-failure counter", () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000 });
    breaker.onFailure();
    breaker.onFailure();
    breaker.onSuccess();
    breaker.onFailure();
    breaker.onFailure();
    expect(breaker.getState()).toBe("CLOSED");
  });
});