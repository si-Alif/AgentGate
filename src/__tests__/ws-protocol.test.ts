import { describe, it, expect, vi } from "vitest";
import { WebSocket } from "ws";
import {
  buildConnectedFrame,
  rejectConnection,
  sendConnectedFrame,
  WS_CLOSE_CODE,
} from "../observability/ws-protocol.js";

function fakeSocket(readyState: number) {
  return { readyState, send: vi.fn(), close: vi.fn() };
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