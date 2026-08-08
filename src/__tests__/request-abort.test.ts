import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { createRequestAbortController } from "../mcp/lifecycle/request-abort.js";

// 1. Extend the mock type to include the 'aborted' property
type FakeRawStream = EventEmitter & { aborted?: boolean };

function fakeRequest(raw: FakeRawStream) {
  return { raw } as any;
}

describe("createRequestAbortController", () => {
  it("aborts when the underlying raw stream emits 'close'", () => {
    const raw: FakeRawStream = new EventEmitter();
    const controller = createRequestAbortController(fakeRequest(raw));

    expect(controller.signal.aborted).toBe(false);

    // 2. Simulate the client explicitly aborting the request
    raw.aborted = true;
    raw.emit("close");

    expect(controller.signal.aborted).toBe(true);
  });

  it("registers exactly ONE close listener, auto-removed after firing (.once semantics)", () => {
    const raw: FakeRawStream = new EventEmitter();
    createRequestAbortController(fakeRequest(raw));

    expect(raw.listenerCount("close")).toBe(1);

    raw.aborted = true;
    raw.emit("close");

    expect(raw.listenerCount("close")).toBe(0);
  });

  it("a second 'close' emission (defensive/adversarial) never throws", () => {
    const raw: FakeRawStream = new EventEmitter();
    const controller = createRequestAbortController(fakeRequest(raw));

    // 3. Ensure the first close is treated as an abort
    raw.aborted = true;
    raw.emit("close");

    expect(() => raw.emit("close")).not.toThrow();
    expect(controller.signal.aborted).toBe(true);
  });
});