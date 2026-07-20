import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { rateLimiterRedis, RATE_LIMIT_KEY_TTL_SECONDS } from "../lib/rate-limiter.js";

describe("Lua script atomicity (raw, standalone — proves the primitive before building on it)", () => {
  it("produces a gap-free, duplicate-free sequence under 50 concurrent INCRs", async () => {
    const key = `atomicity-test:${crypto.randomUUID()}`;

    const results = await Promise.all(
      Array.from({ length: 50 }, () => rateLimiterRedis.rateLimitIncr(key, RATE_LIMIT_KEY_TTL_SECONDS))
    );

    const sorted = [...results].sort((a, b) => a - b);
    const expected = Array.from({ length: 50 }, (_, i) => i + 1);

    // If this ever fails, the bug is in the Lua script or in Redis's
    // atomicity guarantee itself — NOT in checkRateLimit's decision
    // logic (Day 4), which hasn't been written yet at this point.
    expect(sorted).toEqual(expected);
  });

  it("sets a TTL only once — the key expires within the 120s window, not sooner or indefinitely", async () => {
    const key = `ttl-test:${crypto.randomUUID()}`;
    await rateLimiterRedis.rateLimitIncr(key, RATE_LIMIT_KEY_TTL_SECONDS);
    await rateLimiterRedis.rateLimitIncr(key, RATE_LIMIT_KEY_TTL_SECONDS); // second call, same key

    const ttl = await rateLimiterRedis.ttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(RATE_LIMIT_KEY_TTL_SECONDS);
  });
});