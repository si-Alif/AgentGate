import { describe, it, expect, vi, afterEach } from "vitest";
import { WebSocket as WsClient } from "ws";
import type { AddressInfo } from "node:net";
import { startFullSystem, stopFullSystem } from "../helpers/system-harness.js";
import type { SystemHarness } from "../helpers/system-harness.js";
import { createTestTenant, cleanupTenant } from "../helpers/test-tenant.factory.js";
import { tenantEventSubscriber } from "../../observability/ws-tenant-registry.js";

async function mintTicketAndConnect(app: any, port: number, accessToken: string) {
  const res = await app.inject({
    method: "POST", url: "/api/observability/ticket",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const { ticket } = JSON.parse(res.body);
  const ws = new WsClient(`ws://127.0.0.1:${port}/observability/stream?ticket=${ticket}`);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  await new Promise<void>((resolve) => ws.once("message", () => resolve())); // connected frame
  return ws;
}

/**
 * Week 8, Day 4 — Finding W8-3's Instrumented Proof (Decision 8.83).
 *
 * Two independent proofs. Part 1 confirms the INVOCATION-ORDER
 * guarantee (unsubscribe always called before quit) holds via
 * Vitest's own invocationCallOrder — not a timing heuristic, and not
 * merely reasoned about in a comment (Finding F2). Part 2 targets the
 * genuinely open question — whether .quit() actually WAITS for an
 * already-enqueued command's reply — via the most direct signal
 * available: zero UNSUBSCRIBE-failure warnings from
 * deregisterTenantViewer's own existing, already-shipped
 * error-logging path (Week 7 Day 3, Decision 7.46).
 */
describe("Week 8, Day 4 — Shutdown Race: UNSUBSCRIBE vs. quit() (Finding W8-3 / F2)", () => {
  let harness: SystemHarness | undefined;

  afterEach(async () => {
    if (harness) await stopFullSystem(harness).catch(() => { });
    harness = undefined;
  });

  it("GATE — every unsubscribe() invocation is strictly ordered BEFORE quit() is invoked, across multiple concurrently-closing tenants", async () => {
    harness = await startFullSystem();
    const port = (harness.app.server.address() as AddressInfo).port;

    const tenants = await Promise.all(Array.from({ length: 4 }, () => createTestTenant(harness!.app)));
    const sockets = await Promise.all(tenants.map((t) => mintTicketAndConnect(harness!.app, port, t.accessToken)));

    const unsubscribeSpy = vi.spyOn(tenantEventSubscriber, "unsubscribe");
    const quitSpy = vi.spyOn(tenantEventSubscriber, "quit");

    await stopFullSystem(harness);
    const stoppedHarness = harness;
    harness = undefined; // afterEach's own stopFullSystem call becomes a safe no-op

    expect(quitSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    const quitOrder = quitSpy.mock.invocationCallOrder[0]!;
    for (const order of unsubscribeSpy.mock.invocationCallOrder) {
      expect(order).toBeLessThan(quitOrder);
    }
    expect(unsubscribeSpy.mock.calls.length).toBeGreaterThanOrEqual(tenants.length);

    sockets.forEach((s) => s.close());
    unsubscribeSpy.mockRestore();
    quitSpy.mockRestore();
    await Promise.all(tenants.map((t) => cleanupTenant(t.tenantId).catch(() => { })));
  }, 30_000);

  it("GATE — zero UNSUBSCRIBE-failure warnings are logged during a real, multi-tenant shutdown — the direct signal for 'did quit() race ahead of an already-enqueued command'", async () => {
    harness = await startFullSystem();
    const port = (harness.app.server.address() as AddressInfo).port;

    const tenants = await Promise.all(Array.from({ length: 6 }, () => createTestTenant(harness!.app)));
    const sockets = await Promise.all(tenants.map((t) => mintTicketAndConnect(harness!.app, port, t.accessToken)));

    const warnSpy = vi.spyOn(console, "warn");

    await stopFullSystem(harness);
    harness = undefined;

    const unsubscribeFailureWarnings = warnSpy.mock.calls.filter(
      ([msg]) => typeof msg === "string" && msg.includes("UNSUBSCRIBE failed")
    );
    expect(unsubscribeFailureWarnings).toHaveLength(0);

    sockets.forEach((s) => s.close());
    warnSpy.mockRestore();
    await Promise.all(tenants.map((t) => cleanupTenant(t.tenantId).catch(() => { })));
  }, 30_000);
});