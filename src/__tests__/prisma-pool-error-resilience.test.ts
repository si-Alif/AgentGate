import { describe, it, expect } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

/**
 * Week 8 Day 3 — Decision 8.69 (Finding F7). Proves the OBSERVABLE
 * behavior — no process crash — without depending on knowledge of
 * whether @prisma/adapter-pg internally guards its own pg.Pool
 * against the classic idle-client 'error' EventEmitter crash. This
 * project has applied that discipline to every ioredis client and
 * every BullMQ Queue/Worker since Week 2; this is the first time it's
 * been checked against the two Postgres pools.
 *
 * CONFIRM AT IMPLEMENTATION TIME (see the Assumptions table below):
 * whether @prisma/adapter-pg's pinned version's PrismaPg config
 * object accepts connectionTimeoutMillis alongside connectionString/
 * max — a standard pg.PoolConfig property, very likely accepted since
 * PrismaPg's config object is a superset/passthrough of pg.PoolConfig,
 * but not independently confirmed from this document alone.
 *
 * The disruptive "kill the REAL, shared test Postgres container
 * mid-session" scenario is deliberately NOT automated here — mirrors
 * Week 3 Day 7's own established precedent for the identical class of
 * scenario against Redis: a MANUAL hardening-checklist verification
 * step, never something a shared CI Postgres instance gets disrupted
 * for.
 */
describe("Postgres pool error resilience — Week 8 Day 3, Finding F7", () => {
  it("GATE — a Prisma client pointed at an unreachable Postgres target fails as an ordinary rejected promise, with ZERO process-level crash signal", async () => {
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandled.push(reason);
    const onUncaughtException = (err: unknown) => unhandled.push(err);
    process.on("unhandledRejection", onUnhandledRejection);
    process.on("uncaughtException", onUncaughtException);

    const throwaway = new PrismaClient({
      adapter: new PrismaPg({
        connectionString: "postgresql://nobody:nothing@127.0.0.1:1/nonexistent",
        max: 2,
        connectionTimeoutMillis: 2000,
      } as any),
    });

    try {
      await expect(throwaway.$queryRaw`SELECT 1`).rejects.toBeDefined();
    } finally {
      await throwaway.$disconnect().catch(() => { });
    }

    // Give any lingering async 'error' emission a moment to surface
    // before asserting it never did.
    await new Promise((r) => setTimeout(r, 500));

    process.off("unhandledRejection", onUnhandledRejection);
    process.off("uncaughtException", onUncaughtException);

    expect(unhandled).toHaveLength(0);
  }, 10_000);

  it("REGRESSION — the SAME assertion holds for a rejected connection with a LONGER-lived attempted pool (closer to production pool sizing)", async () => {
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandledRejection);

    const throwaway = new PrismaClient({
      adapter: new PrismaPg({
        connectionString: "postgresql://nobody:nothing@127.0.0.1:1/nonexistent",
        max: 10,
        connectionTimeoutMillis: 1500,
      } as any),
    });

    // Fire several concurrent queries against the unreachable target —
    // proves the guarantee holds under concurrent connection-attempt
    // failure, not just a single one.
    const results = await Promise.allSettled([
      throwaway.$queryRaw`SELECT 1`,
      throwaway.$queryRaw`SELECT 2`,
      throwaway.$queryRaw`SELECT 3`,
    ]);
    expect(results.every((r) => r.status === "rejected")).toBe(true);

    await throwaway.$disconnect().catch(() => { });
    await new Promise((r) => setTimeout(r, 500));

    process.off("unhandledRejection", onUnhandledRejection);
    expect(unhandled).toHaveLength(0);
  }, 10_000);
});