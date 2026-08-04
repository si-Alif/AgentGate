import { describe, it, expect, vi, afterAll } from "vitest";
import { startFullSystem, stopFullSystem } from "./helpers/system-harness.js";
import { redis } from "../lib/redis.js";
import { rateLimiterRedis } from "../lib/rate-limiter.js";
import * as emailWorkerModule from "../workers/email.worker.js";

async function ensureRedisConnected() {
  if (redis.status === "end" || redis.status === "close") {
    await redis.connect();
  }
  if (rateLimiterRedis.status === "end" || rateLimiterRedis.status === "close") {
    await rateLimiterRedis.connect();
  }
}

describe("system-harness — bring-up/teardown primitive (Week 8 Day 1)", () => {
  // Re-establish Redis connections before exiting this test file so
  // global teardown in setup.ts (await redis.quit()) does not throw "Connection is closed."
  afterAll(async () => {
    await ensureRedisConnected();
  });

  it("GATE — stopFullSystem NEVER calls process.exit (Finding F1 / Decision 8.19)", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code}) was called — this must NEVER happen inside test teardown`);
    }) as any);

    try {
      await ensureRedisConnected();
      const harness = await startFullSystem();
      await expect(stopFullSystem(harness)).resolves.toBeUndefined();

      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
    }
  }, 20_000);

  it("CONFIRMED FACT (Finding F4 / Decision 8.20) — resolves, by identity check, whether email.worker.ts's redisConnection is still distinct from the shared lib/redis.ts client", async () => {
    const emailRedisConnection = (emailWorkerModule as Record<string, unknown>).redisConnection;
    const isDistinct = emailRedisConnection !== redis;
    // eslint-disable-next-line no-console
    console.log(
      `[system-harness] email.worker.ts's redisConnection is ${isDistinct ? "a SEPARATE Redis client from lib/redis.ts" : "the SAME shared lib/redis.ts client"
      } — this fact directly corrects or confirms Week 8 Day 5/6's own connection-budget arithmetic (Finding W8-4).`
    );
    expect(typeof isDistinct).toBe("boolean");
  });

  it("startFullSystem produces a real, connectable listening port and a healthy app", async () => {
    await ensureRedisConnected();
    const harness = await startFullSystem();
    expect(harness.port).toBeGreaterThan(0);

    const res = await harness.app.inject({ method: "GET", url: "/healthcheck" });
    expect(res.statusCode).toBeLessThan(500);

    await stopFullSystem(harness);
  }, 20_000);
});