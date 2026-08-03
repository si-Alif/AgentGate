import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WebSocket } from "ws";
import { startHeartbeat, stopHeartbeat, isHeartbeatActive } from "../observability/ws-heartbeat.js";
import * as wsProtocol from "../observability/ws-protocol.js";
import { env } from "../config/env.js";

function fakeSocket() {
  const listeners: Record<string, Function[]> = {};
  return {
    readyState: WebSocket.OPEN,
    ping: vi.fn(),
    send: vi.fn(),
    terminate: vi.fn(),
    on(event: string, cb: Function) {
      (listeners[event] ??= []).push(cb);
    },
    emit(event: string, ...args: unknown[]) {
      (listeners[event] ?? []).forEach((cb) => cb(...args));
    },
  };
}

describe("ws-heartbeat", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("pings on every interval tick while the connection stays alive (pong received each time)", () => {
    const socket = fakeSocket();
    startHeartbeat(socket as any);

    vi.advanceTimersByTime(env.AGENTGATE_WS_HEARTBEAT_INTERVAL_MS);
    expect(socket.ping).toHaveBeenCalledTimes(1);
    socket.emit("pong"); // simulate the peer responding

    vi.advanceTimersByTime(env.AGENTGATE_WS_HEARTBEAT_INTERVAL_MS);
    expect(socket.ping).toHaveBeenCalledTimes(2);

    stopHeartbeat(socket as any);
  });

  it("GATE — a single missed pong terminates the connection via terminateUnresponsiveConnection, never a graceful close", () => {
    const socket = fakeSocket();
    const terminateSpy = vi.spyOn(wsProtocol, "terminateUnresponsiveConnection");
    startHeartbeat(socket as any);

    vi.advanceTimersByTime(env.AGENTGATE_WS_HEARTBEAT_INTERVAL_MS); // ping #1, no pong ever arrives
    vi.advanceTimersByTime(env.AGENTGATE_WS_HEARTBEAT_INTERVAL_MS); // check finds isAlive still false -> terminate

    expect(terminateSpy).toHaveBeenCalledTimes(1);
    expect(terminateSpy).toHaveBeenCalledWith(socket, wsProtocol.WS_CLOSE_CODE.HEARTBEAT_TIMEOUT);
    expect(socket.terminate).toHaveBeenCalledTimes(1);
    expect(socket.ping).toHaveBeenCalledTimes(1); // never got a SECOND ping — terminated instead

    terminateSpy.mockRestore();
  });

  it("stopHeartbeat clears the interval — no further ping calls after stopping", () => {
    const socket = fakeSocket();
    startHeartbeat(socket as any);
    stopHeartbeat(socket as any);

    vi.advanceTimersByTime(env.AGENTGATE_WS_HEARTBEAT_INTERVAL_MS * 3);
    expect(socket.ping).not.toHaveBeenCalled();
  });

  it("GATE — stopHeartbeat is idempotent: never-started and already-stopped sockets never throw", () => {
    const socket = fakeSocket();
    expect(() => stopHeartbeat(socket as any)).not.toThrow(); // never started
    startHeartbeat(socket as any);
    stopHeartbeat(socket as any);
    expect(() => stopHeartbeat(socket as any)).not.toThrow(); // already stopped
  });

  it("isHeartbeatActive reflects start/stop state correctly", () => {
    const socket = fakeSocket();
    expect(isHeartbeatActive(socket as any)).toBe(false);
    startHeartbeat(socket as any);
    expect(isHeartbeatActive(socket as any)).toBe(true);
    stopHeartbeat(socket as any);
    expect(isHeartbeatActive(socket as any)).toBe(false);
  });

  it("a ping() call that throws does not crash the interval loop, and is retried next tick", () => {
    const socket = fakeSocket();
    (socket.ping as any).mockImplementationOnce(() => { throw new Error("simulated"); });
    startHeartbeat(socket as any);

    expect(() => vi.advanceTimersByTime(env.AGENTGATE_WS_HEARTBEAT_INTERVAL_MS)).not.toThrow();
    socket.emit("pong");
    vi.advanceTimersByTime(env.AGENTGATE_WS_HEARTBEAT_INTERVAL_MS);
    expect(socket.ping).toHaveBeenCalledTimes(2);

    stopHeartbeat(socket as any);
  });

  it("respects an intervalMsOverride distinct from the env default (testability seam)", () => {
    const socket = fakeSocket();
    startHeartbeat(socket as any, 500);

    vi.advanceTimersByTime(500);
    expect(socket.ping).toHaveBeenCalledTimes(1);

    stopHeartbeat(socket as any);
  });
});