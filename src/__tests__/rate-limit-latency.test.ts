import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { checkRateLimit } from "../lib/rate-limiter.js";

describe("checkRateLimit — latency (PRD §12 target: p95 < 5ms)", () => {
  it("p95 latency stays under 5ms against local Redis", async () => {
    const agentId = `latency-test-${crypto.randomUUID()}`;
    const samples: number[] = [];

    for (let i = 0; i < 200; i++) {
      const start = performance.now();
      await checkRateLimit(agentId, 100_000); // effectively unlimited — measuring latency, not denial
      samples.push(performance.now() - start);
    }

    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor(samples.length * 0.95)] as number;
    // eslint-disable-next-line no-console
    console.log(`checkRateLimit p95 latency (local Redis): ${p95.toFixed(2)}ms`);

    expect(p95).toBeLessThan(5);
  });
});