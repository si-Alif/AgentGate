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

describe("ws-tenant-registry", () => {
  beforeEach(async () => {
    await resetTenantRegistryForTest();
  });

  afterAll(async () => {
    await resetTenantRegistryForTest();
    await closeTenantEventSubscriber();
  });

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