import { describe, it, expect, vi } from "vitest";
import { WebSocket } from "ws";
import {
  buildConnectedFrame,
  rejectConnection,
  sendConnectedFrame,
  WS_CLOSE_CODE,
  buildEventFrame,
  sendEventFrame
} from "../observability/ws-protocol.js";
import type { LiveExecutionEvent } from "../lib/audit-publish.js";
import { terminateUnresponsiveConnection } from "../observability/ws-protocol.js";


function fakeSocket(readyState: number) {
  return { readyState, send: vi.fn(), close: vi.fn() };
}

function sampleEvent(overrides: Partial<LiveExecutionEvent> = {}): LiveExecutionEvent {
  return {
    id: "evt-1", tenantId: "tenant-1", eventType: "TOOL_INVOCATION",
    agentId: "agent-1", toolId: "tool-1", status: "success", durationMs: 42,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe("buildConnectedFrame", () => {
  it("returns EXACTLY {type, serverTime, tenantId} — no role, no userId", () => {
    const frame = buildConnectedFrame("tenant-123");
    expect(Object.keys(frame).sort()).toEqual(["serverTime", "tenantId", "type"]);
    expect(frame.type).toBe("connected");
    expect(frame.tenantId).toBe("tenant-123");
    expect(new Date(frame.serverTime).toString()).not.toBe("Invalid Date");
  });
});

describe("WS_CLOSE_CODE — taxonomy values match Part 4.2 exactly", () => {
  it("standard IANA codes are untouched", () => {
    expect(WS_CLOSE_CODE.NORMAL).toBe(1000);
    expect(WS_CLOSE_CODE.GOING_AWAY).toBe(1001);
    expect(WS_CLOSE_CODE.POLICY_VIOLATION).toBe(1008);
  });
  it("application codes are in the RFC 6455 §7.4 private-use range, including today's additions", () => {
    expect(WS_CLOSE_CODE.TICKET_INVALID).toBe(4001);
    expect(WS_CLOSE_CODE.ORIGIN_NOT_ALLOWED).toBe(4002);
    expect(WS_CLOSE_CODE.CONNECTION_CEILING_EXCEEDED).toBe(4003);
    expect(WS_CLOSE_CODE.HEARTBEAT_TIMEOUT).toBe(4004);
    expect(WS_CLOSE_CODE.SERVICE_DEGRADED).toBe(4005); // NEW today
    expect(WS_CLOSE_CODE.TOO_MANY_CONNECTION_ATTEMPTS).toBe(4006); // NEW today
  });
});

describe("rejectConnection — Decision 7.35 / Finding F4", () => {
  it("sends an error frame BEFORE closing, when the socket is OPEN", () => {
    const socket = fakeSocket(WebSocket.OPEN);
    rejectConnection(socket as any, WS_CLOSE_CODE.TICKET_INVALID);

    expect(socket.send).toHaveBeenCalledTimes(1);
    const sentFrame = JSON.parse(socket.send.mock.calls[0]![0] as string);
    expect(sentFrame).toEqual({ type: "error", code: 4001, message: expect.any(String) });

    expect(socket.close).toHaveBeenCalledWith(4001, expect.any(String));
    // Order matters — send() must be invoked before close().
    expect(socket.send.mock.invocationCallOrder[0]!).toBeLessThan(socket.close.mock.invocationCallOrder[0]!);
  });

  it("does NOT call send() when the socket is not OPEN, but still closes", () => {
    const socket = fakeSocket(WebSocket.CLOSING);
    rejectConnection(socket as any, WS_CLOSE_CODE.ORIGIN_NOT_ALLOWED);
    expect(socket.send).not.toHaveBeenCalled();
    expect(socket.close).toHaveBeenCalledWith(4002, expect.any(String));
  });

  it("never throws even if send() itself throws", () => {
    const socket = fakeSocket(WebSocket.OPEN);
    socket.send.mockImplementation(() => { throw new Error("boom"); });
    expect(() => rejectConnection(socket as any, WS_CLOSE_CODE.SERVICE_DEGRADED)).not.toThrow();
    expect(socket.close).toHaveBeenCalled(); // still attempted despite the send() failure
  });

  it("never throws even if close() itself throws", () => {
    const socket = fakeSocket(WebSocket.OPEN);
    socket.close.mockImplementation(() => { throw new Error("already closed"); });
    expect(() => rejectConnection(socket as any, WS_CLOSE_CODE.CONNECTION_CEILING_EXCEEDED)).not.toThrow();
  });

  it("caps the close reason at 123 UTF-8 bytes (RFC 6455 §5.5.1)", () => {
    const socket = fakeSocket(WebSocket.OPEN);
    rejectConnection(socket as any, WS_CLOSE_CODE.TICKET_INVALID, "x".repeat(500));
    const [, reason] = socket.close.mock.calls[0]!;
    expect(Buffer.byteLength(reason, "utf-8")).toBeLessThanOrEqual(123);
  });
});

describe("sendConnectedFrame", () => {
  it("sends exactly one message shaped as a connected frame", () => {
    const socket = { send: vi.fn() };
    sendConnectedFrame(socket as any, "tenant-abc");
    expect(socket.send).toHaveBeenCalledTimes(1);
    const frame = JSON.parse((socket.send as any).mock.calls[0][0]);
    expect(frame.type).toBe("connected");
    expect(frame.tenantId).toBe("tenant-abc");
  });
});

describe("buildEventFrame — Day 3, Decision 7.42", () => {
  it("flat-merges {type: 'event'} with the LiveExecutionEvent — no nested wrapper", () => {
    const event = sampleEvent();
    const frame = buildEventFrame(event);
    expect(frame.type).toBe("event");
    expect(frame.id).toBe(event.id);
    expect(frame.tenantId).toBe(event.tenantId);
    expect((frame as any).event).toBeUndefined(); // proves NO nested wrapper
  });

  it("carries optional fields through untouched when present", () => {
    const frame = buildEventFrame(sampleEvent({ errorCode: "TIMEOUT" }));
    expect(frame.errorCode).toBe("TIMEOUT");
  });

  it("omits optional fields entirely when absent on the source event", () => {
    const minimal: LiveExecutionEvent = {
      id: "evt-2", tenantId: "tenant-2", eventType: "AGENT_AUTHENTICATED",
      timestamp: new Date().toISOString(),
    };
    const frame = buildEventFrame(minimal);
    expect("agentId" in frame).toBe(false);
    expect("toolId" in frame).toBe(false);
    expect("status" in frame).toBe(false);
  });
});

describe("sendEventFrame", () => {
  it("sends exactly one message shaped as an event frame", () => {
    const socket = { send: vi.fn() };
    const event = sampleEvent();
    sendEventFrame(socket as any, event);
    expect(socket.send).toHaveBeenCalledTimes(1);
    const frame = JSON.parse((socket.send as any).mock.calls[0][0]);
    expect(frame.type).toBe("event");
    expect(frame.id).toBe(event.id);
  });
});

describe("terminateUnresponsiveConnection — Day 4, Decision 7.50 / Finding F3", () => {
  function fakeSocketWithTerminate(readyState: number) {
    return { readyState, send: vi.fn(), terminate: vi.fn() };
  }

  it("attempts to send an error frame when OPEN, then calls terminate() — never close()", () => {
    const socket = fakeSocketWithTerminate(WebSocket.OPEN);
    terminateUnresponsiveConnection(socket as any, WS_CLOSE_CODE.HEARTBEAT_TIMEOUT);

    expect(socket.send).toHaveBeenCalledTimes(1);
    const frame = JSON.parse((socket.send as any).mock.calls[0][0]);
    expect(frame).toEqual({ type: "error", code: 4004, message: expect.any(String) });
    expect(socket.terminate).toHaveBeenCalledTimes(1);
    // The load-bearing distinction from rejectConnection():
    expect((socket as any).close).toBeUndefined();
  });

  it("does not attempt to send when the socket is not OPEN, but still terminates", () => {
    const socket = fakeSocketWithTerminate(WebSocket.CLOSING);
    terminateUnresponsiveConnection(socket as any, WS_CLOSE_CODE.HEARTBEAT_TIMEOUT);
    expect(socket.send).not.toHaveBeenCalled();
    expect(socket.terminate).toHaveBeenCalledTimes(1);
  });

  it("never throws even if send() itself throws — terminate() is still attempted", () => {
    const socket = fakeSocketWithTerminate(WebSocket.OPEN);
    (socket.send as any).mockImplementation(() => { throw new Error("boom"); });
    expect(() => terminateUnresponsiveConnection(socket as any, WS_CLOSE_CODE.HEARTBEAT_TIMEOUT)).not.toThrow();
    expect(socket.terminate).toHaveBeenCalledTimes(1);
  });

  it("never throws even if terminate() itself throws", () => {
    const socket = fakeSocketWithTerminate(WebSocket.OPEN);
    (socket.terminate as any).mockImplementation(() => { throw new Error("already gone"); });
    expect(() => terminateUnresponsiveConnection(socket as any, WS_CLOSE_CODE.HEARTBEAT_TIMEOUT)).not.toThrow();
  });
});

describe("WS_CLOSE_REASON — Day 4 addition", () => {
  it("rejectConnection uses a specific, non-generic reason for POLICY_VIOLATION", () => {
    const socket = { readyState: WebSocket.OPEN, send: vi.fn(), close: vi.fn() };
    rejectConnection(socket as any, WS_CLOSE_CODE.POLICY_VIOLATION);
    const frame = JSON.parse((socket.send as any).mock.calls[0][0]);
    expect(frame.message).toBe("Backpressure threshold exceeded");
    expect(frame.message).not.toBe("Connection rejected"); // the old generic fallback
  });
});