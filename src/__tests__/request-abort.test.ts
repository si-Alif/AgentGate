import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { createRequestAbortController } from "../mcp/lifecycle/request-abort.js";

function fakeRequest(raw: EventEmitter) {
  return { raw } as any;
}

describe("createRequestAbortController", () => {
  it("aborts when the underlying raw stream emits 'close'", () => {
    const raw = new EventEmitter();
    const controller = createRequestAbortController(fakeRequest(raw));
    expect(controller.signal.aborted).toBe(false);
    raw.emit("close");
    expect(controller.signal.aborted).toBe(true);
  });

  it("registers exactly ONE close listener, auto-removed after firing (.once semantics)", () => {
    const raw = new EventEmitter();
    createRequestAbortController(fakeRequest(raw));
    expect(raw.listenerCount("close")).toBe(1);
    raw.emit("close");
    expect(raw.listenerCount("close")).toBe(0);
  });

  it("a second 'close' emission (defensive/adversarial) never throws", () => {
    const raw = new EventEmitter();
    const controller = createRequestAbortController(fakeRequest(raw));
    raw.emit("close");
    expect(() => raw.emit("close")).not.toThrow();
    expect(controller.signal.aborted).toBe(true);
  });
});