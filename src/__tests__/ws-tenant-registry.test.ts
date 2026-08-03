import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { WebSocket } from "ws";
import crypto from "node:crypto";
import { redis } from "../lib/redis.js";
import { tenantEventChannelName } from "../lib/audit-publish.js";
import type { LiveExecutionEvent } from "../lib/audit-publish.js";
import {
  tenantEventSubscriber,
  registerTenantViewer,
  deregisterTenantViewer,
  dispatchTenantMessage,
  getViewerCountForTenant,
  getSubscribedTenantCount,
  closeTenantEventSubscriber,
  resetTenantRegistryForTest,
} from "../observability/ws-tenant-registry.js";
import { WS_CLOSE_CODE } from "../observability/ws-protocol.js";
import { env } from "../config/env.js";

function fakeSocket(readyState: number = WebSocket.OPEN) {
  return { readyState, send: vi.fn() } as unknown as WebSocket;
}

function sampleEvent(tenantId: string): LiveExecutionEvent {
  return {
    id: crypto.randomUUID(), tenantId, eventType: "TOOL_INVOCATION",
    agentId: "agent-1", toolId: "tool-1", status: "success", durationMs: 10,
    timestamp: new Date().toISOString(),
  };
}

beforeEach(async () => {
  await resetTenantRegistryForTest();
});

afterAll(async () => {
  await resetTenantRegistryForTest();
  await closeTenantEventSubscriber();
});

describe("ws-tenant-registry", () => {


  it("GATE — the subscriber connection is a genuinely SEPARATE instance from the shared redis client (Finding F1)", () => {
    expect(tenantEventSubscriber).not.toBe(redis);
  });

  it("GATE — the subscriber connection is built from redis.ts's options, NOT rateLimiterRedis's fail-fast settings (Decision 7.41)", () => {
    expect((tenantEventSubscriber as any).options.maxRetriesPerRequest).toBeNull();
  });

  it("GATE — first viewer for a tenant triggers exactly one SUBSCRIBE; a second viewer for the SAME tenant triggers zero additional", async () => {
    const spy = vi.spyOn(tenantEventSubscriber, "subscribe");
    const tenantId = crypto.randomUUID();
    registerTenantViewer(tenantId, fakeSocket());
    await new Promise((r) => setTimeout(r, 20));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(tenantEventChannelName(tenantId));

    registerTenantViewer(tenantId, fakeSocket());
    await new Promise((r) => setTimeout(r, 20));
    expect(spy).toHaveBeenCalledTimes(1); // still just one

    spy.mockRestore();
  });

  it("GATE — closing one of two viewers leaves the channel subscribed; closing the LAST one triggers exactly one UNSUBSCRIBE", async () => {
    const subSpy = vi.spyOn(tenantEventSubscriber, "subscribe");
    const unsubSpy = vi.spyOn(tenantEventSubscriber, "unsubscribe");
    const tenantId = crypto.randomUUID();
    const socketA = fakeSocket();
    const socketB = fakeSocket();

    registerTenantViewer(tenantId, socketA);
    registerTenantViewer(tenantId, socketB);
    await new Promise((r) => setTimeout(r, 20));
    expect(subSpy).toHaveBeenCalledTimes(1);

    deregisterTenantViewer(tenantId, socketA);
    await new Promise((r) => setTimeout(r, 20));
    expect(unsubSpy).not.toHaveBeenCalled();
    expect(getViewerCountForTenant(tenantId)).toBe(1);

    deregisterTenantViewer(tenantId, socketB);
    await new Promise((r) => setTimeout(r, 20));
    expect(unsubSpy).toHaveBeenCalledTimes(1);
    expect(unsubSpy).toHaveBeenCalledWith(tenantEventChannelName(tenantId));
    expect(getViewerCountForTenant(tenantId)).toBe(0);

    subSpy.mockRestore();
    unsubSpy.mockRestore();
  });

  it("GATE — deregistration is idempotent: never-registered and already-removed sockets never throw", () => {
    const tenantId = crypto.randomUUID();
    const socket = fakeSocket();
    expect(() => deregisterTenantViewer(tenantId, socket)).not.toThrow();
    registerTenantViewer(tenantId, socket);
    deregisterTenantViewer(tenantId, socket);
    expect(() => deregisterTenantViewer(tenantId, socket)).not.toThrow();
  });

  it("two different tenants have fully independent subscribe lifecycles", async () => {
    const subSpy = vi.spyOn(tenantEventSubscriber, "subscribe");
    const tenantA = crypto.randomUUID();
    const tenantB = crypto.randomUUID();
    registerTenantViewer(tenantA, fakeSocket());
    registerTenantViewer(tenantB, fakeSocket());
    await new Promise((r) => setTimeout(r, 20));
    expect(subSpy).toHaveBeenCalledWith(tenantEventChannelName(tenantA));
    expect(subSpy).toHaveBeenCalledWith(tenantEventChannelName(tenantB));
    expect(getSubscribedTenantCount()).toBe(2);
    subSpy.mockRestore();
  });

  describe("dispatchTenantMessage", () => {
    it("delivers the event frame to every registered viewer of the matching tenant", () => {
      const tenantId = crypto.randomUUID();
      const socketA = fakeSocket();
      const socketB = fakeSocket();
      registerTenantViewer(tenantId, socketA);
      registerTenantViewer(tenantId, socketB);

      const event = sampleEvent(tenantId);
      dispatchTenantMessage(tenantEventChannelName(tenantId), JSON.stringify(event));

      for (const socket of [socketA, socketB]) {
        expect((socket as any).send).toHaveBeenCalledTimes(1);
        const frame = JSON.parse((socket as any).send.mock.calls[0][0]);
        expect(frame).toMatchObject({ type: "event", id: event.id, tenantId });
      }
    });

    it("GATE — cross-tenant isolation at the dispatch layer: a socket registered under a DIFFERENT tenant never receives it", () => {
      const tenantA = crypto.randomUUID();
      const tenantB = crypto.randomUUID();
      const socketA = fakeSocket();
      const socketB = fakeSocket();
      registerTenantViewer(tenantA, socketA);
      registerTenantViewer(tenantB, socketB);

      dispatchTenantMessage(tenantEventChannelName(tenantA), JSON.stringify(sampleEvent(tenantA)));

      expect((socketA as any).send).toHaveBeenCalledTimes(1);
      expect((socketB as any).send).not.toHaveBeenCalled();
    });

    it("GATE — a tenant with ZERO registered viewers: the payload is never even parsed", () => {
      const tenantId = crypto.randomUUID(); // never registered
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
      expect(() =>
        dispatchTenantMessage(tenantEventChannelName(tenantId), "{not valid json")
      ).not.toThrow();
      expect(errorSpy).not.toHaveBeenCalled(); // proves we returned BEFORE the parse's own try/catch ran
      errorSpy.mockRestore();
    });

    it("a malformed payload for a tenant WITH viewers is caught, logged, and never partially delivers", () => {
      const tenantId = crypto.randomUUID();
      const socket = fakeSocket();
      registerTenantViewer(tenantId, socket);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });

      expect(() =>
        dispatchTenantMessage(tenantEventChannelName(tenantId), "{not valid json")
      ).not.toThrow();
      expect(errorSpy).toHaveBeenCalled();
      expect((socket as any).send).not.toHaveBeenCalled();

      errorSpy.mockRestore();
    });

    it("GATE — a socket already CLOSED is skipped and never prevents delivery to the rest of that tenant's viewers", () => {
      const tenantId = crypto.randomUUID();
      const closedSocket = fakeSocket(WebSocket.CLOSED);
      const openSocket = fakeSocket(WebSocket.OPEN);
      registerTenantViewer(tenantId, closedSocket);
      registerTenantViewer(tenantId, openSocket);

      dispatchTenantMessage(tenantEventChannelName(tenantId), JSON.stringify(sampleEvent(tenantId)));

      expect((closedSocket as any).send).not.toHaveBeenCalled();
      expect((openSocket as any).send).toHaveBeenCalledTimes(1);
    });

    it("GATE — one socket's send() throwing never prevents delivery to the rest of that tenant's viewers", () => {
      const tenantId = crypto.randomUUID();
      const throwingSocket = fakeSocket();
      (throwingSocket as any).send = vi.fn(() => { throw new Error("simulated send failure"); });
      const healthySocket = fakeSocket();
      registerTenantViewer(tenantId, throwingSocket);
      registerTenantViewer(tenantId, healthySocket);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => { });

      expect(() =>
        dispatchTenantMessage(tenantEventChannelName(tenantId), JSON.stringify(sampleEvent(tenantId)))
      ).not.toThrow();

      expect((healthySocket as any).send).toHaveBeenCalledTimes(1);
      warnSpy.mockRestore();
    });
  });

  describe("failure hygiene (Decision 7.46)", () => {
    it("a SUBSCRIBE rejection is caught and logged, never an unhandled rejection", async () => {
      const spy = vi.spyOn(tenantEventSubscriber, "subscribe").mockRejectedValue(new Error("ECONNRESET"));
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
      expect(() => registerTenantViewer(crypto.randomUUID(), fakeSocket())).not.toThrow();
      await new Promise((r) => setTimeout(r, 20));
      expect(errorSpy).toHaveBeenCalled();
      spy.mockRestore();
      errorSpy.mockRestore();
    });

    it("an UNSUBSCRIBE rejection is caught and logged, never an unhandled rejection", async () => {
      const tenantId = crypto.randomUUID();
      const socket = fakeSocket();
      registerTenantViewer(tenantId, socket);
      await new Promise((r) => setTimeout(r, 20));

      const spy = vi.spyOn(tenantEventSubscriber, "unsubscribe").mockRejectedValue(new Error("ECONNRESET"));
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => { });
      expect(() => deregisterTenantViewer(tenantId, socket)).not.toThrow();
      await new Promise((r) => setTimeout(r, 20));
      expect(warnSpy).toHaveBeenCalled();

      spy.mockRestore();
      warnSpy.mockRestore();
    });
  });

  it("subscriber connection survives a synthetic 'error' event without crashing", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
    expect(() => tenantEventSubscriber.emit("error", new Error("simulated blip"))).not.toThrow();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe("dispatchTenantMessage — Day 4 backpressure gating (Decision 7.53/7.54)", () => {
  it("GATE — a socket over the backpressure threshold is rejected with POLICY_VIOLATION and never sent the event", () => {
    const tenantId = crypto.randomUUID();
    const overloaded = fakeSocket();
    (overloaded as any).bufferedAmount = env.AGENTGATE_WS_BACKPRESSURE_THRESHOLD_BYTES + 1;
    (overloaded as any).close = vi.fn();

    registerTenantViewer(tenantId, overloaded);
    dispatchTenantMessage(tenantEventChannelName(tenantId), JSON.stringify(sampleEvent(tenantId)));

    expect((overloaded as any).send).toHaveBeenCalledTimes(1); // the error frame only
    const sentFrame = JSON.parse((overloaded as any).send.mock.calls[0][0]);
    expect(sentFrame).toMatchObject({ type: "error", code: WS_CLOSE_CODE.POLICY_VIOLATION });
    expect((overloaded as any).close).toHaveBeenCalledWith(WS_CLOSE_CODE.POLICY_VIOLATION, expect.any(String));
  });

  it("a socket exactly AT the threshold is still sent to (strictly-greater-than semantics)", () => {
    const tenantId = crypto.randomUUID();
    const socket = fakeSocket();
    (socket as any).bufferedAmount = env.AGENTGATE_WS_BACKPRESSURE_THRESHOLD_BYTES;
    registerTenantViewer(tenantId, socket);

    dispatchTenantMessage(tenantEventChannelName(tenantId), JSON.stringify(sampleEvent(tenantId)));

    expect((socket as any).send).toHaveBeenCalledTimes(1);
    expect(JSON.parse((socket as any).send.mock.calls[0][0]).type).toBe("event");
  });

  it("GATE — one overloaded socket rejected mid-fan-out never prevents delivery to the REST of that tenant's healthy viewers", () => {
    const tenantId = crypto.randomUUID();
    const overloaded = fakeSocket();
    (overloaded as any).bufferedAmount = env.AGENTGATE_WS_BACKPRESSURE_THRESHOLD_BYTES + 1;
    (overloaded as any).close = vi.fn();
    const healthy = fakeSocket();
    registerTenantViewer(tenantId, overloaded);
    registerTenantViewer(tenantId, healthy);

    dispatchTenantMessage(tenantEventChannelName(tenantId), JSON.stringify(sampleEvent(tenantId)));

    expect((healthy as any).send).toHaveBeenCalledTimes(1);
    expect(JSON.parse((healthy as any).send.mock.calls[0][0]).type).toBe("event");
  });

  it("Finding F4 regression guard — the fan-out loop tolerates a synchronous mutation of the SAME viewer Set mid-iteration without skipping or double-processing any socket", () => {
    // Simulates the theoretical hazard the Array.from() snapshot
    // defends against, proving the snapshot actually holds even if a
    // future change reintroduces synchronous mutation.
    const tenantId = crypto.randomUUID();
    const socketA = fakeSocket();
    const socketB = fakeSocket();
    registerTenantViewer(tenantId, socketA);
    registerTenantViewer(tenantId, socketB);

    const originalSend = (socketA as any).send;
    (socketA as any).send = vi.fn((...args: unknown[]) => {
      deregisterTenantViewer(tenantId, socketB); // synchronous mutation of the live Set
      return originalSend(...args);
    });

    expect(() =>
      dispatchTenantMessage(tenantEventChannelName(tenantId), JSON.stringify(sampleEvent(tenantId)))
    ).not.toThrow();
    // socketB was already snapshotted before the mutation — it still
    // receives the event this one time, proving the snapshot, not
    // luck, is what's protecting the loop.
    expect((socketB as any).send).toHaveBeenCalledTimes(1);
  });
});

import {
  getAllRegisteredSockets,
  getTotalViewerCount,
  closeAllObservabilityConnections,
  getObservabilityStreamHealth,
} from "../observability/ws-tenant-registry.js";

describe("getAllRegisteredSockets / getTotalViewerCount — Week 7 Day 5, Decision 7.63", () => {
  it("returns every registered socket across every tenant, deduplicated", () => {
    const tenantA = crypto.randomUUID();
    const tenantB = crypto.randomUUID();
    const socketA1 = fakeSocket();
    const socketA2 = fakeSocket();
    const socketB1 = fakeSocket();
    registerTenantViewer(tenantA, socketA1);
    registerTenantViewer(tenantA, socketA2);
    registerTenantViewer(tenantB, socketB1);

    const all = getAllRegisteredSockets();
    expect(all).toHaveLength(3);
    expect(new Set(all)).toEqual(new Set([socketA1, socketA2, socketB1]));
    expect(getTotalViewerCount()).toBe(3);
  });

  it("returns an empty array when nothing is registered", () => {
    expect(getAllRegisteredSockets()).toEqual([]);
    expect(getTotalViewerCount()).toBe(0);
  });
});

describe("closeAllObservabilityConnections — Week 7 Day 5, Decision 7.63/7.64", () => {
  it("GATE — closes every registered socket, and lets their OWN close listeners deregister them (no manual cleanup call)", async () => {
    const tenantId = crypto.randomUUID();
    const socket = fakeSocket();

    // 1. Maintain an array so multiple "close" listeners can coexist
    const closeListeners: Function[] = [];
    (socket as any).once = (socket as any).on = (event: string, cb: Function) => {
      if (event === "close") closeListeners.push(cb);
    };

    // 2. Trigger all registered listeners when close() is invoked
    (socket as any).close = vi.fn(() => {
      setImmediate(() => {
        for (const cb of [...closeListeners]) cb();
      });
    });
    (socket as any).terminate = vi.fn();

    // 3. Attach the socket's OWN close listener to simulate real connection lifecycle
    (socket as any).once("close", () => deregisterTenantViewer(tenantId, socket));

    registerTenantViewer(tenantId, socket);
    expect(getViewerCountForTenant(tenantId)).toBe(1);

    await closeAllObservabilityConnections(1000);

    expect((socket as any).close).toHaveBeenCalledWith(WS_CLOSE_CODE.GOING_AWAY, expect.any(String));
    expect(getViewerCountForTenant(tenantId)).toBe(0); // deregisterTenantViewer's listener now successfully fires!
  });
});

describe("getObservabilityStreamHealth — Week 7 Day 5, Decision 7.67", () => {
  it("GATE — reports HEALTHY via a REAL round-trip PING while genuinely subscribed to at least one channel", async () => {
    const tenantId = crypto.randomUUID();
    registerTenantViewer(tenantId, fakeSocket());
    await new Promise((r) => setTimeout(r, 30)); // let the real SUBSCRIBE settle

    const health = await getObservabilityStreamHealth();
    expect(health.healthy).toBe(true);
    expect(health.reason).toBe("HEALTHY");
    expect(health.subscribedTenantCount).toBeGreaterThanOrEqual(1);
  });

  it("reports SUBSCRIBER_NOT_READY without attempting a PING when the connection's status isn't 'ready'", async () => {
    const statusSpy = vi.spyOn(tenantEventSubscriber, "status", "get").mockReturnValue("connecting");
    const pingSpy = vi.spyOn(tenantEventSubscriber, "ping");
    const health = await getObservabilityStreamHealth();
    expect(health.reason).toBe("SUBSCRIBER_NOT_READY");
    expect(pingSpy).not.toHaveBeenCalled();
    statusSpy.mockRestore();
    pingSpy.mockRestore();
  });

  it("reports PING_TIMEOUT when the PING hangs past the 2s budget", async () => {
    const pingSpy = vi.spyOn(tenantEventSubscriber, "ping").mockImplementation(() => new Promise(() => { }));
    const health = await getObservabilityStreamHealth();
    expect(health.reason).toBe("PING_TIMEOUT");
    pingSpy.mockRestore();
  }, 5_000);

  it("reports PING_ERROR on an immediate PING rejection", async () => {
    const pingSpy = vi.spyOn(tenantEventSubscriber, "ping").mockRejectedValue(new Error("ECONNRESET"));
    const health = await getObservabilityStreamHealth();
    expect(health.reason).toBe("PING_ERROR");
    pingSpy.mockRestore();
  });

  it("never throws, even under a totally unexpected internal failure", async () => {
    const spy = vi.spyOn(tenantEventSubscriber, "status", "get").mockImplementation(() => { throw new Error("boom"); });
    await expect(getObservabilityStreamHealth()).resolves.toMatchObject({ healthy: false });
    spy.mockRestore();
  });
});