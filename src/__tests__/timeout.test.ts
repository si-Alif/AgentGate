import { describe, it, expect, vi } from "vitest";
import { withTimeout } from "../lib/timeout.js";
import { TimeoutError } from "../handlers/types.js";

describe("withTimeout — happy path", () => {
  it("resolves with fn's value when it settles inside the budget", async () => {
    const result = await withTimeout(async () => "done", 1_000);
    expect(result).toBe("done");
  });
});

describe("withTimeout — the backstop (Decision 5.2)", () => {
  it("rejects with TimeoutError once timeoutMs elapses, even when fn NEVER settles and never checks its own signal", async () => {
    // This is the scenario a naive setTimeout-based wrapper cannot
    // handle: fn() deliberately ignores the signal it's given,
    // simulating a handler that forgot to wire abort handling. The
    // Promise.race backstop must still bound this function's own
    // returned promise.
    const start = performance.now();
    await expect(withTimeout(() => new Promise(() => { }), 50)).rejects.toThrow(TimeoutError);
    expect(performance.now() - start).toBeLessThan(1_000);
  });

  it("rejects immediately if the external signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(withTimeout(async () => "unreachable", 5_000, controller.signal)).rejects.toThrow(TimeoutError);
  });

  it("rejects when the external signal fires before the internal timeout would", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const start = performance.now();
    await expect(withTimeout(() => new Promise(() => { }), 5_000, controller.signal)).rejects.toThrow(TimeoutError);
    expect(performance.now() - start).toBeLessThan(1_000);
  });

  it("propagates fn's own rejection when fn fails BEFORE the timeout fires (not misreported as a timeout)", async () => {
    await expect(
      withTimeout(async () => {
        throw new Error("genuine handler bug, unrelated to timing");
      }, 5_000)
    ).rejects.toThrow("genuine handler bug, unrelated to timing");
  });
});

describe("withTimeout — listener hygiene (Decision 5.3)", () => {
  it("does not accumulate listeners on a long-lived external signal across many reused calls", async () => {
    const controller = new AbortController();
    const warnSpy = vi.fn();
    process.on("warning", warnSpy);

    for (let i = 0; i < 50; i++) {
      await withTimeout(async () => "ok", 1_000, controller.signal);
    }

    // A MaxListenersExceededWarning would fire on `controller.signal`
    // itself if a listener were added directly to it on every call
    // and never removed — exactly the leak class this design avoids
    // by listening on the per-call combinedSignal instead.
    expect(warnSpy).not.toHaveBeenCalled();
    process.removeListener("warning", warnSpy);
  });
});