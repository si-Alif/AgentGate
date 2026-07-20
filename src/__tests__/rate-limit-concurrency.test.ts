import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { checkRateLimit } from "../lib/rate-limiter.js";

describe("checkRateLimit — concurrency proof", () => {
  it("allows exactly 10 and denies exactly 10 under 20 truly concurrent calls with limit=10", async () => {
    const agentId = `concurrency-test-${crypto.randomUUID()}`;

    // Promise.all fires all 20 calls before any of them resolve —
    // this is what makes "concurrent" true here. The atomicity
    // guarantee comes from Redis executing the Lua script
    // single-threaded server-side, not from any client-side ordering.
    const results = await Promise.all(
      Array.from({ length: 20 }, () => checkRateLimit(agentId, 10))
    );

    const allowedCount = results.filter((r) => r.allowed).length;
    const deniedCount = results.filter((r) => !r.allowed).length;

    expect(allowedCount).toBe(10);
    expect(deniedCount).toBe(10);
  });

  it("is exactly right across multiple repeated runs, not just once", async () => {
    for (let i = 0; i < 5; i++) {
      const agentId = `concurrency-repeat-${i}-${crypto.randomUUID()}`;
      const results = await Promise.all(
        Array.from({ length: 20 }, () => checkRateLimit(agentId, 10))
      );
      expect(results.filter((r) => r.allowed).length).toBe(10);
    }
  });
});