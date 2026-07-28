import { describe, it, expect, afterAll } from "vitest";
import { getSafeAgent } from "../lib/safe-agent.js";

describe("getSafeAgent() — shared singleton lifecycle (Day 6, new)", () => {
  it("returns the SAME Agent instance across repeated calls", () => {
    expect(getSafeAgent()).toBe(getSafeAgent());
  });

  it("stays open and usable across many sequential calls from unrelated code paths", () => {
    for (let i = 0; i < 25; i++) {
      expect(getSafeAgent().closed).toBe(false);
    }
  });

  // Documents Finding #3 rather than papering over it. Flip this to a
  // real assertion once server.ts's shutdown sequence is extended —
  // tracked for Day 7, not a Day 6 blocker, but it must not be
  // forgotten once the file is skimmed later.
  it.todo("(Day 7 follow-up) the shared agent is closed exactly once by the graceful shutdown sequence");
});

afterAll(async () => {
  // Local cleanup so this file doesn't leak an open Agent into the
  // rest of the Vitest run — NOT a substitute for real shutdown wiring.
  await getSafeAgent().close().catch(() => {});
});