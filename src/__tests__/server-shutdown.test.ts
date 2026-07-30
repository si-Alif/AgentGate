import { describe, it, expect, vi } from "vitest";
import { withTimeout } from "../lib/timeout.js";

describe("bounded shutdown helper (logic check)", () => {
  it("resolves immediately when close() finishes within grace", async () => {
    const closeMock = vi.fn().mockResolvedValue(undefined);
    const worker = { close: closeMock } as any;

    // Simulate the shutdown logic
    await withTimeout(() => worker.close(), 3000);
    expect(closeMock).toHaveBeenCalledWith(); // no force
  });

  it("force‑closes after timeout", async () => {
    const closeMock = vi.fn().mockImplementation((force?: boolean) => {
      if (force) return Promise.resolve();
      return new Promise(() => { }); // never resolve gracefully
    });
    const worker = { close: closeMock } as any;

    try {
      await withTimeout(() => worker.close(), 50);
    } catch (err: any) {
      if (err.name === "TimeoutError") {
        await worker.close(true);
      }
    }
    expect(closeMock).toHaveBeenCalledWith(true);
  });
});