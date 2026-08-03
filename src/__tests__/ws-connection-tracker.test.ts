import { describe, it, expect, beforeEach } from "vitest";
import type { WebSocket } from "ws";
import {
  registerConnection,
  deregisterConnection,
  getActiveConnectionCount,
  resetAllConnectionsForTest,
} from "../observability/ws-connection-tracker.js";

function fakeSocket(): WebSocket {
  return {} as WebSocket; // identity is all that matters — Set membership, not behavior
}

describe("ws-connection-tracker", () => {
  beforeEach(() => resetAllConnectionsForTest());

  it("allows registrations up to the configured ceiling, denies the next one", () => {
    const userId = "user-1";
    const sockets = Array.from({ length: 5 }, fakeSocket); // AGENTGATE_WS_MAX_CONNECTIONS_PER_USER default
    for (const s of sockets) {
      expect(registerConnection(userId, s).registered).toBe(true);
    }
    const overflow = registerConnection(userId, fakeSocket());
    expect(overflow.registered).toBe(false);
    expect(overflow.currentCount).toBe(5);
  });

  it("deregistering frees a slot for a subsequent registration", () => {
    const userId = "user-2";
    const sockets = Array.from({ length: 5 }, fakeSocket);
    sockets.forEach((s) => registerConnection(userId, s));
    expect(registerConnection(userId, fakeSocket()).registered).toBe(false);

    deregisterConnection(userId, sockets[0]!);
    expect(getActiveConnectionCount(userId)).toBe(4);
    expect(registerConnection(userId, fakeSocket()).registered).toBe(true);
  });

  it("GATE — deregistration is idempotent: a socket never registered, or already removed, never throws", () => {
    const userId = "user-3";
    const s = fakeSocket();
    expect(() => deregisterConnection(userId, s)).not.toThrow(); // never registered
    registerConnection(userId, s);
    deregisterConnection(userId, s);
    expect(() => deregisterConnection(userId, s)).not.toThrow(); // already removed
    expect(getActiveConnectionCount(userId)).toBe(0);
  });

  it("different users have fully independent ceilings", () => {
    const socketsA = Array.from({ length: 5 }, fakeSocket);
    socketsA.forEach((s) => registerConnection("user-a", s));
    expect(registerConnection("user-a", fakeSocket()).registered).toBe(false);
    // user-b starts fresh, unaffected by user-a being at ceiling
    expect(registerConnection("user-b", fakeSocket()).registered).toBe(true);
  });

  it("a fully-vacated user is removed from the map entirely (no stale empty Sets)", () => {
    const userId = "user-4";
    const s = fakeSocket();
    registerConnection(userId, s);
    deregisterConnection(userId, s);
    expect(getActiveConnectionCount(userId)).toBe(0);
  });
});