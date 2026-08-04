import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { WebSocket as WsClient } from "ws";
import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { startFullSystem, stopFullSystem } from "./helpers/system-harness.js";
import type { SystemHarness } from "./helpers/system-harness.js";
import {
  createTestTenant,
  createTestAgent,
  createTestTool,
  createSsrfBlockedTool,
  cleanupTenant,
} from "./helpers/test-tenant.factory.js";
import { permissionService } from "../services/permission.service.js";
import { agentRepository } from "../repositories/agent.repository.js";
import { env } from "../config/env.js";

// ── shared, minimal test-local helpers, matching this project's
// established connect/collect/waitFor convention (Week 5/6/7) ──

function connectAndCollect(url: string) {
  const ws = new WsClient(url);
  const messages: any[] = [];
  ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
  const closed = new Promise<{ code: number }>((resolve) => ws.once("close", (code) => resolve({ code })));
  return { ws, messages, closed };
}

async function waitForMessage(
  ws: WsClient,
  predicate?: (m: any) => boolean,
  timeoutMs = 5000
): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for a matching WS message")), timeoutMs);
    const handler = (data: Buffer) => {
      const parsed = JSON.parse(data.toString());
      if (!predicate || predicate(parsed)) {
        clearTimeout(timer);
        ws.off("message", handler);
        resolve(parsed);
      }
    };
    ws.on("message", handler);
  });
}

async function waitFor(assertion: () => Promise<void> | void, timeoutMs = 10_000, intervalMs = 150): Promise<void> {
  const start = Date.now();
  while (true) {
    try {
      await assertion();
      return;
    } catch (err) {
      if (Date.now() - start > timeoutMs) throw err;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}

function mcpEnvelope(method: string, params: unknown, id: string | number) {
  return { jsonrpc: "2.0", id, method, params, _meta: { protocolVersion: "2026-07-28" } };
}

async function mcpCall(app: FastifyInstance, apiKey: string, method: string, params: unknown, id: string | number) {
  const res = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: { authorization: `Bearer ${apiKey}` },
    payload: mcpEnvelope(method, params, id),
  });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

/**
 * Week 8, Day 1 — The Full-System E2E Harness.
 *
 * Composes M1-M7 in ONE process, against real Postgres, real Redis,
 * real BullMQ workers, and a real listening Fastify instance, for the
 * FIRST time anywhere in this project (roadmap_w8.md's own stated
 * purpose). Eight sequential, DEPENDENT `it()` blocks share one
 * describe-scoped context (Decision 8.23) — no beforeEach/afterEach
 * reset between them, matching the master roadmap's own explicit
 * "zero teardown/setup between flows" checkpoint requirement. A
 * single top-level beforeAll/afterAll brings the whole stack up once
 * and tears it down once.
 *
 * Because these flows are DELIBERATELY dependent (not independent
 * scenarios the way every prior week's own test files were), a
 * failure in an early flow will cascade into later ones failing too —
 * that is expected and correct here, not a design flaw: it's the
 * direct consequence of proving "one continuous run" rather than
 * eight isolated ones.
 *
 * Flow order follows roadmap_w8.md Part 5's own Day 1 listing
 * (Decision 8.23 / Finding F7), with one deliberate composition
 * improvement (Decision 8.22 / Finding F6): Tenant A's WS connection
 * is opened once, early (end of Flow 1), and stays open through Flows
 * 3-5. Flow 6 ("WS delivery") asserts against messages ALREADY
 * captured on that live connection — it triggers nothing new. This
 * also keeps the harness's total WS-connect-attempt budget at exactly
 * 2 for the whole run (Finding F3 / Decision 8.26).
 */
describe("Week 8, Day 1 — Full-System E2E Harness", () => {
  let harness: SystemHarness;

  // Shared, progressively-populated context (Decision 8.23).
  let tenantA: { tenantId: string; userId: string; accessToken: string };
  let agentA: { id: string };
  let apiKeyA: string;
  let toolA: { id: string; name: string }; // Flow 3's permitted, SSRF-blocked tool
  let toolAUnpermitted: { id: string; name: string }; // Flow 4's tool, no grant
  let wsA: ReturnType<typeof connectAndCollect>;

  let toolInvocationEventId: string | undefined;
  let permissionDeniedEventId: string | undefined;
  let rateLimitedEventId: string | undefined;

  beforeAll(async () => {
    harness = await startFullSystem();
  }, 30_000);

  afterAll(async () => {
    if (wsA) wsA.ws.close();
    if (tenantA) await cleanupTenant(tenantA.tenantId).catch(() => { });
    await stopFullSystem(harness);
  }, 20_000);

  it("FLOW 1 — Bootstrap & agent identity resolution (cold-cache MCP auth)", async () => {
    tenantA = await createTestTenant(harness.app);
    const createdAgent = await createTestAgent(tenantA.tenantId, tenantA.userId);
    agentA = createdAgent.agent;
    apiKeyA = createdAgent.apiKey;

    const toolRow = await createSsrfBlockedTool(tenantA.tenantId, `harness-flow3-tool-${crypto.randomUUID()}`);
    toolA = { id: toolRow.id, name: toolRow.name };
    await permissionService.assignPermission(tenantA.tenantId, { agentId: agentA.id, toolId: toolA.id });

    const unpermittedRow = await createTestTool(tenantA.tenantId, {
      name: `harness-flow4-tool-${crypto.randomUUID()}`,
    });
    toolAUnpermitted = { id: unpermittedRow.id, name: unpermittedRow.name };
    // Deliberately NO permission grant for toolAUnpermitted — Flow 4 needs this.

    const { status, body } = await mcpCall(harness.app, apiKeyA, "tools/list", {}, "flow1-list");
    expect(status).toBe(200);
    expect(body.result.tools.map((t: any) => t.name)).toContain(toolA.name);

    // Open Tenant A's WS connection HERE (Decision 8.22) — it stays
    // open through Flows 3-5; Flow 6 observes what it accumulates
    // without ever reconnecting.
    const ticketRes = await harness.app.inject({
      method: "POST",
      url: "/api/observability/ticket",
      headers: { Authorization: `Bearer ${tenantA.accessToken}` }, // human JWT — a DIFFERENT auth plane from apiKeyA
    });
    const { ticket } = JSON.parse(ticketRes.body);

    wsA = connectAndCollect(`ws://127.0.0.1:${harness.port}/observability/stream?ticket=${ticket}`);
    const connectedFrame = await waitForMessage(wsA.ws, (m) => m.type === "connected");
    expect(connectedFrame.tenantId).toBe(tenantA.tenantId);
  }, 30_000);

  it("FLOW 2 — tools/list warm-cache correctness (zero DB hit on the second call)", async () => {
    const spy = vi.spyOn(agentRepository, "findByKeyIdWithTenantContext");

    const { status, body } = await mcpCall(harness.app, apiKeyA, "tools/list", {}, "flow2-list");
    expect(status).toBe(200);
    expect(body.result.cacheScope).toBe("agent");
    expect(spy).not.toHaveBeenCalled(); // warm auth-accelerator-cache hit, Week 6 Day 2

    spy.mockRestore();
  }, 15_000);

  it("FLOW 3 — tools/call: full five-module pipeline, real SSRF Layer 2, live WS delivery, durable audit", async () => {
    const { body } = await mcpCall(harness.app, apiKeyA, "tools/call", { name: toolA.name }, "flow3-call");
    // SSRF-blocked deliberately (the established Week 4/6/7 pattern)
    // — proves the FULL pipeline ran: permission -> AJV -> rate limit
    // -> decrypt -> dispatch -> SSRF Layer 2 -> audit.
    expect(body.error?.code).toBe(-32008);

    const eventFrame = await waitForMessage(wsA.ws, (m) => m.type === "event" && m.eventType === "TOOL_INVOCATION");
    expect(eventFrame.tenantId).toBe(tenantA.tenantId);
    expect(eventFrame.toolId).toBe(toolA.id);
    toolInvocationEventId = eventFrame.id;
  }, 15_000);

  it("FLOW 4 — permission denial: live WS delivery, durable audit with correct denialReason", async () => {
    const { body } = await mcpCall(
      harness.app,
      apiKeyA,
      "tools/call",
      { name: toolAUnpermitted.name },
      "flow4-call"
    );
    expect(body.error?.code).toBe(-32000);

    const eventFrame = await waitForMessage(wsA.ws, (m) => m.type === "event" && m.eventType === "PERMISSION_DENIED");
    expect(eventFrame.toolId).toBe(toolAUnpermitted.id);
    expect(eventFrame.denialReason).toBe("not_found");
    permissionDeniedEventId = eventFrame.id;
  }, 15_000);

  it("FLOW 5 — rate limit denial: exhausts the real per-agent ceiling, live WS delivery, durable audit", async () => {
    const limit = env.AGENTGATE_MCP_TOOL_CALL_RATE_LIMIT;

    // Deliberately does NOT try to account precisely for Flow 3's own
    // earlier contribution to this SAME per-agent counter (checkPermission
    // runs before checkRateLimit, so Flow 4's denial never touched it —
    // only Flow 3's one call did). Looping comfortably past the limit
    // and asserting only the FINAL call is denied is simpler and more
    // robust than exact cross-flow counting, and matches the
    // established pattern from Week 6 Day 5's own e2e rate-limit test.
    for (let i = 0; i < limit + 2; i++) {
      await mcpCall(harness.app, apiKeyA, "tools/call", { name: toolA.name }, `flow5-${i}`);
    }
    const { body: overBody } = await mcpCall(harness.app, apiKeyA, "tools/call", { name: toolA.name }, "flow5-over");
    expect(overBody.error?.code).toBe(-32001);

    const eventFrame = await waitForMessage(wsA.ws, (m) => m.type === "event" && m.eventType === "RATE_LIMITED");
    expect(eventFrame.tenantId).toBe(tenantA.tenantId);
    rateLimitedEventId = eventFrame.id;
  }, 25_000);

  it("FLOW 6 — WS delivery, composed: one connection opened in Flow 1 observed all three event types live, correctly scoped, in-process", async () => {
    // Deliberately triggers NOTHING new (Decision 8.22) — asserts
    // against wsA's OWN accumulated `messages` buffer from Flows 3-5,
    // proving genuine same-process, same-connection composition
    // rather than a reconnect-and-check pattern.
    const eventTypes = wsA.messages.filter((m) => m.type === "event").map((m) => m.eventType);
    expect(eventTypes).toEqual(expect.arrayContaining(["TOOL_INVOCATION", "PERMISSION_DENIED", "RATE_LIMITED"]));
    expect(wsA.messages.every((m) => m.type !== "event" || m.tenantId === tenantA.tenantId)).toBe(true);
  });

  it("FLOW 7 — audit completeness: every event observed live is durably persisted, correctly attributed, and cross-referenced by the SAME id", async () => {
    expect(toolInvocationEventId).toBeDefined();
    expect(permissionDeniedEventId).toBeDefined();
    expect(rateLimitedEventId).toBeDefined();

    await waitFor(async () => {
      const res = await harness.app.inject({
        method: "GET",
        url: `/api/audit-events/${toolInvocationEventId}`,
        headers: { Authorization: `Bearer ${tenantA.accessToken}` },
      });
      expect(res.statusCode).toBe(200);
      const detail = JSON.parse(res.body);
      expect(detail.eventType).toBe("TOOL_INVOCATION");
      expect(detail.toolId).toBe(toolA.id);
    });

    await waitFor(async () => {
      const res = await harness.app.inject({
        method: "GET",
        url: `/api/audit-events/${permissionDeniedEventId}`,
        headers: { Authorization: `Bearer ${tenantA.accessToken}` },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).eventType).toBe("PERMISSION_DENIED");
    });

    await waitFor(async () => {
      const res = await harness.app.inject({
        method: "GET",
        url: `/api/audit-events/${rateLimitedEventId}`,
        headers: { Authorization: `Bearer ${tenantA.accessToken}` },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).eventType).toBe("RATE_LIMITED");
    });
  }, 20_000);

  it("FLOW 8 — tenant isolation across every surface (REST, MCP, WS, audit-read)", async () => {
    const tenantB = await createTestTenant(harness.app);
    const createdB = await createTestAgent(tenantB.tenantId, tenantB.userId);

    // (a) MCP: Tenant B's tools/list never includes Tenant A's tool
    const listB = await mcpCall(harness.app, createdB.apiKey, "tools/list", {}, "flow8-list");
    expect(listB.body.result.tools.map((t: any) => t.name)).not.toContain(toolA.name);

    // (b) MCP: Tenant B's agent cannot invoke Tenant A's tool by name
    const callB = await mcpCall(harness.app, createdB.apiKey, "tools/call", { name: toolA.name }, "flow8-call");
    expect(callB.body.error?.code).toBe(-32003); // TOOL_NOT_FOUND — tenant-scoped name resolution

    // (c) Audit-read: Tenant B cannot fetch Tenant A's own known, valid event id
    const auditRes = await harness.app.inject({
      method: "GET",
      url: `/api/audit-events/${toolInvocationEventId}`,
      headers: { Authorization: `Bearer ${tenantB.accessToken}` },
    });
    expect(auditRes.statusCode).toBe(404);

    // (d) WS: a live connection under Tenant B never observes ANY of
    // Tenant A's traffic — regardless of whether Tenant A's own
    // trigger below succeeds, is denied, or is rate-limited, it still
    // produces SOME live event under Tenant A's tenantId.
    const ticketResB = await harness.app.inject({
      method: "POST",
      url: "/api/observability/ticket",
      headers: { Authorization: `Bearer ${tenantB.accessToken}` },
    });
    const { ticket: ticketB } = JSON.parse(ticketResB.body);
    const wsB = connectAndCollect(`ws://127.0.0.1:${harness.port}/observability/stream?ticket=${ticketB}`);
    await waitForMessage(wsB.ws, (m) => m.type === "connected");

    await mcpCall(harness.app, apiKeyA, "tools/call", { name: toolA.name }, "flow8-trigger-a");

    let leaked = false;
    await Promise.race([
      waitForMessage(wsB.ws, (m) => m.type === "event").then(() => {
        leaked = true;
      }),
      new Promise((resolve) => setTimeout(resolve, 500)),
    ]);
    expect(leaked).toBe(false);

    wsB.ws.close();
    await cleanupTenant(tenantB.tenantId);
  }, 20_000);

  it("BONUS — /health reports every subsystem healthy after a full composed run (Decision 8.24 / Finding F8)", async () => {
    const res = await harness.app.inject({ method: "GET", url: "/healthcheck" });
    const body = JSON.parse(res.body);

    expect(res.statusCode).toBe(200);
    expect(body.rateLimiter.healthy).toBe(true);
    // mcpGatewayCache is literally the SAME object as rateLimiter
    // (Week 6 Day 5 Decision 5.8) — checked here for completeness of
    // the reported shape, not as an independent signal.
    expect(body.mcpGatewayCache.healthy).toBe(true);
    expect(body.observabilityStream.healthy).toBe(true);
    // audit is reported but its own healthy flag can legitimately be
    // false under transient queue-depth conditions right after a
    // burst — reported, not hard-gated.
    expect(body.audit).toBeDefined();
  });
});