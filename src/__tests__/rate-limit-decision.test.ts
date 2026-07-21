import { describe, it, expect } from "vitest";
import { evaluateRateLimit } from "../lib/rate-limiter.js";

describe("evaluateRateLimit (pure — no Redis, no async, no mocks)", () => {
  it("allows when count is strictly below the limit", () => {
    expect(evaluateRateLimit(1, 10)).toEqual({ allowed: true, remaining: 9 });
    expect(evaluateRateLimit(5, 10)).toEqual({ allowed: true, remaining: 5 });
  });

  it("allows when count equals the limit (boundary)", () => {
    expect(evaluateRateLimit(10, 10)).toEqual({ allowed: true, remaining: 0 });
  });

  it("denies when count exceeds the limit by one", () => {
    expect(evaluateRateLimit(11, 10)).toEqual({ allowed: false, remaining: 0 });
  });

  it("denies when count far exceeds the limit", () => {
    expect(evaluateRateLimit(1000, 10)).toEqual({ allowed: false, remaining: 0 });
  });

  it("remaining never goes negative, even far over limit", () => {
    expect(evaluateRateLimit(1000, 10).remaining).toBe(0);
    expect(evaluateRateLimit(11, 0).remaining).toBe(0);
  });

  it("handles limit=0 correctly (denies everything)", () => {
    expect(evaluateRateLimit(0, 0)).toEqual({ allowed: true, remaining: 0 });
    expect(evaluateRateLimit(1, 0)).toEqual({ allowed: false, remaining: 0 });
  });

  it("handles count=0 correctly (full budget remaining)", () => {
    expect(evaluateRateLimit(0, 10)).toEqual({ allowed: true, remaining: 10 });
  });

  it("is symmetric: allowed === (remaining > 0 || count <= limit)", () => {
    for (let limit = 0; limit <= 20; limit++) {
      for (let count = 0; count <= 25; count++) {
        const result = evaluateRateLimit(count, limit);
        if (result.allowed) {
          expect(count).toBeLessThanOrEqual(limit);
        } else {
          expect(count).toBeGreaterThan(limit);
        }
        expect(result.remaining).toBeGreaterThanOrEqual(0);
      }
    }
  });
});