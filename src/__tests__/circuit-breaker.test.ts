import { describe, it, expect } from "vitest";
import { CircuitBreaker } from "../lib/circuit-breaker.js";

describe("CircuitBreaker — state machine", () => {
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

describe("CircuitBreaker — probeInFlight guard (Finding #3 fix)", () => {
  it("allows exactly one concurrent probe in HALF_OPEN state", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 50 });
    breaker.onFailure(); // Trip to OPEN

    await new Promise((r) => setTimeout(r, 60)); // Cooldown elapsed

    // Simulate two "concurrent" requests reaching canAttempt().
    // In Node.js these execute sequentially on the event loop,
    // which is exactly the interleaving we want to guard against.
    const r1 = breaker.canAttempt();
    const r2 = breaker.canAttempt();

    expect(r1).toBe(true);   // First probe allowed
    expect(r2).toBe(false);  // Second probe blocked
    expect(breaker.getState()).toBe("HALF_OPEN");
  });

  it("releases probeInFlight on success so a new probe can follow", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 50 });
    breaker.onFailure();
    await new Promise((r) => setTimeout(r, 60));

    expect(breaker.canAttempt()).toBe(true); // probe 1
    breaker.onSuccess(); // releases probe

    expect(breaker.getState()).toBe("CLOSED");
    expect(breaker.canAttempt()).toBe(true); // can attempt again normally
  });

  it("releases probeInFlight on failure so HALF_OPEN can be re-entered", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 50 });
    breaker.onFailure();
    await new Promise((r) => setTimeout(r, 60));

    expect(breaker.canAttempt()).toBe(true); // probe 1
    breaker.onFailure(); // back to OPEN, releases probe

    expect(breaker.getState()).toBe("OPEN");
    expect(breaker.canAttempt()).toBe(false); // still in cooldown
  });

  it("reset() clears probeInFlight even if a probe was abandoned", () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 50 });
    breaker.onFailure();

    // Manually simulate HALF_OPEN with an in-flight probe
    // (this would happen if canAttempt() returned true but the
    // caller crashed before calling onSuccess/onFailure)
    (breaker as any).state = "HALF_OPEN";
    (breaker as any).probeInFlight = true;

    expect(breaker.canAttempt()).toBe(false); // blocked by probeInFlight

    breaker.reset();
    expect(breaker.getState()).toBe("CLOSED");
    expect(breaker.canAttempt()).toBe(true);
  });
});