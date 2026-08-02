import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from "vitest";
import * as executeToolModule from "../lib/execute-tool.js";
import { permissionService } from "../services/permission.service.js";
import { createTestTenant, createTestAgent, createTestTool, cleanupTenant } from "./helpers/test-tenant.factory.js";
import { startLiveServer } from "./helpers/live-server.js";
import { sendMcpRequest } from "./helpers/mcp-test-client.js";
import { env } from "../config/env.js";
import { createApp } from "../app.js";
import type { FastifyInstance } from "fastify";

describe("Day 6 — Live-Socket Gates (F2 disconnect, F3 cold-start, F5 timeout config)", () => {

  afterEach(() => vi.restoreAllMocks());

  it("GATE (F5, Decision 6.6) — Fastify's server-level timeouts genuinely reflect AGENTGATE_MCP_REQUEST_TIMEOUT_MS (closes Day 2's deferred item)", async () => {
    const app = await createApp();
    // requestTimeout: Fastify's own constructor option -> Node's
    // http.Server#requestTimeout property, directly.
    expect(app.server.requestTimeout).toBe(env.AGENTGATE_MCP_REQUEST_TIMEOUT_MS);
    // connectionTimeout: Fastify's constructor option -> the legacy
    // http.Server#timeout property (socket idle timeout), NOT a
    // property literally named connectionTimeout on the Node server —
    // stated precisely rather than assumed. See roadmap_w6_d6.md §A.6.
    expect(app.server.timeout).toBe(env.AGENTGATE_MCP_REQUEST_TIMEOUT_MS);
    await app.close();
  });

  let app: FastifyInstance;

  beforeAll(async () => {
    app = await createApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("GATE (F2, Decision 6.3) — a genuine client disconnect (real socket abort) reaches executeTool's AbortSignal and stops backend work", async () => {
    const live = await startLiveServer();
    const tenant = await createTestTenant(app);
    const { agent, apiKey } = await createTestAgent(tenant.tenantId, tenant.userId);
    const tool = await createTestTool(tenant.tenantId);
    await permissionService.assignPermission(tenant.tenantId, { agentId: agent.id, toolId: tool.id });

    let observedSignal: AbortSignal | undefined;
    const spy = vi.spyOn(executeToolModule, "executeTool").mockImplementation(
      (_toolId, _tenantId, _agentId, _args, signal) =>
        new Promise((_resolve, reject) => {
          observedSignal = signal;
          signal?.addEventListener("abort", () => reject(new Error("aborted by client disconnect")));
          // Deliberately never resolves on its own within this test's window.
        })
    );

    const controller = new AbortController();
    const inFlight = sendMcpRequest(
      live.baseUrl,
      { method: "tools/call", params: { name: tool.name, arguments: {} } },
      { apiKey, signal: controller.signal }
    );

    // FIX: Dynamically wait until the request genuinely reaches the handler server-side
    await vi.waitFor(() => {
      expect(observedSignal).toBeDefined();
    }, { timeout: 3000 });

    expect(observedSignal?.aborted).toBe(false); // confirmed still in-flight before the abort

    controller.abort();
    await expect(inFlight).rejects.toThrow(); // the CLIENT's own fetch() promise rejects

    // The load-bearing assertion: the SERVER's own signal, threaded all
    // the way into executeTool(), transitioned to aborted as a result
    // of the real socket closing — not merely that the client gave up.
    await vi.waitFor(() => {
      expect(observedSignal!.aborted).toBe(true);
    }, { timeout: 3000 });

    spy.mockRestore();
    await live.close();
    await cleanupTenant(tenant.tenantId);
  });

  it("GATE (F3, Decision 6.4) — a cold-start replica: a SECOND, independently-constructed FastifyInstance, sharing only Postgres/Redis, correctly serves the very first request it has ever seen", async () => {
    // Two genuinely separate FastifyInstances — the closest proxy to
    // "two replicas behind a load balancer with no sticky sessions"
    // achievable within one Vitest process. Stated limitation: both
    // instances share Node's module-level globalValidatorCache (Day 1)
    // within this one process, which two real OS processes would not.
    // Controlled for below by using a tool/schema NEITHER instance has
    // ever compiled a validator for. See roadmap_w6_d6.md §A.4.
    const replicaOne = await createApp();
    const replicaTwo = await createApp();

    const tenant = await createTestTenant(app);
    const { agent, apiKey } = await createTestAgent(tenant.tenantId, tenant.userId);
    const tool = await createTestTool(tenant.tenantId, {
      // A schema shape unique to this test run — guarantees a genuine
      // AJV cache MISS on whichever instance handles the first call.
      inputSchema: { type: "object", properties: { coldStartMarker: { type: "string" } } },
    } as any);
    await permissionService.assignPermission(tenant.tenantId, { agentId: agent.id, toolId: tool.id });

    // replicaOne never touches this agent/tool pair at all — simulating
    // a load balancer routing this brand-new agent's FIRST EVER request
    // directly to "replica two."
    const res = await replicaTwo.inject({
      method: "POST", url: "/mcp",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: {
        jsonrpc: "2.0", id: "cold-start", method: "tools/list",
        _meta: { protocolVersion: "2026-07-28" },
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.result.tools.some((t: any) => t.name === tool.name)).toBe(true);

    // Prove replicaOne would have produced the IDENTICAL result — i.e.
    // correctness never depended on which instance was hit first.
    const resOne = await replicaOne.inject({
      method: "POST", url: "/mcp",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: {
        jsonrpc: "2.0", id: "cold-start-cross-check", method: "tools/list",
        _meta: { protocolVersion: "2026-07-28" },
      },
    });
    expect(JSON.parse(resOne.body).result.tools).toEqual(body.result.tools);

    await replicaOne.close();
    await replicaTwo.close();
    await cleanupTenant(tenant.tenantId);
  });
});