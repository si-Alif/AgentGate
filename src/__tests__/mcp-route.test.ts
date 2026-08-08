import { describe, it, expect, vi, beforeEach , afterEach } from "vitest";
import { createApp } from "../app.js";
import * as originValidator from "../mcp/http/origin-validator.js";
import { agentRepository } from "../repositories/agent.repository.js";
import { env } from "../config/env.js";
import { createTestTenant, createTestAgent, cleanupTenant } from "./helpers/test-tenant.factory.js";

describe("GET /mcp", () => {


  it("returns 405 with an Allow: POST header", async () => {
    const app = await createApp();
    const res = await app.inject({ method: "GET", url: "/mcp" });
    expect(res.statusCode).toBe(405);
    expect(res.headers.allow).toBe("POST");
    await app.close();
  });
});

describe("POST /mcp — transport-level rejections (before body processing)", () => {
  it("rejects a disallowed Origin with 403 and code -32012", async () => {
    const app = await createApp();
    const spy = vi.spyOn(originValidator, "isOriginAllowed").mockReturnValue(false);
    const res = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { origin: "https://evil.example" },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.code).toBe(-32012);
    spy.mockRestore();
    await app.close();
  });

  it("returns 429 once the coarse message-rate limit is exceeded for the same identity", async () => {
    const app = await createApp();
    const limit = env.AGENTGATE_MCP_MESSAGE_RATE_LIMIT;
    let last;

    for (let i = 0; i < limit + 1; i++) {
      last = await app.inject({
        method: "POST",
        url: "/mcp",
        remoteAddress: "192.168.100.100", // <-- THE FIX: Isolate this test's IP
        payload: { jsonrpc: "2.0", id: i, method: "x" }
      });
    }

    expect(last!.statusCode).toBe(429);
    expect(JSON.parse(last!.body).error.code).toBe(-32010);
    await app.close();
  }, 15_000);
});

describe("POST /mcp — envelope and identity failures (in-body, HTTP 200 + JSON-RPC error)", () => {
  let app: Awaited<ReturnType<typeof createApp>>;
  beforeEach(async () => {
    app = await createApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it("rejects a structurally invalid envelope with -32600", async () => {
    const res = await app.inject({ method: "POST", url: "/mcp", payload: { jsonrpc: "2.0" } }); // missing method/_meta
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe(-32600);
  });

  it("rejects an unsupported protocol version with -32011, preserving the request id", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/mcp",
      payload: {
        jsonrpc: "2.0",
        id: "req-1",
        method: "tools/list",
        _meta: { protocolVersion: "2025-11-25" },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe(-32011);
    expect(body.id).toBe("req-1");
  });

  it("rejects a missing Authorization header with -32009", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/mcp",
      payload: {
        jsonrpc: "2.0",
        id: "req-2",
        method: "tools/list",
        _meta: { protocolVersion: "2026-07-28" },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).error.code).toBe(-32009);
  });

  it("CHECKPOINT — a real valid credential resolves end-to-end; second call proves a Postgres-free cache hit", async () => {
    const app = await createApp();
    const tenant = await createTestTenant(app);
    const { apiKey } = await createTestAgent(tenant.tenantId, tenant.userId);
    const payload = {
      jsonrpc: "2.0",
      id: "req-3",
      method: "tools/list",
      _meta: { protocolVersion: "2026-07-28" },
    };

    const first = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { authorization: `Bearer ${apiKey}` },
      payload,
    });
    expect(first.statusCode).toBe(200);
    expect(JSON.parse(first.body).result).toBeDefined();

    const spy = vi.spyOn(agentRepository, "findByKeyIdWithTenantContext");
    const second = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { authorization: `Bearer ${apiKey}` },
      payload,
    });
    expect(second.statusCode).toBe(200);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();

    await cleanupTenant(tenant.tenantId);
  });

  describe("POST /mcp — identity-resolution infra fault (Week 9 Day 1, Decision 9.2)", () => {
    it("GATE — a raw DB fault during identity resolution maps to -32002, never -32603 or -32009", async () => {
      const spy = vi.spyOn(agentRepository, "findByKeyIdWithTenantContext").mockRejectedValue(new Error("ECONNRESET"));

      const res = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: { authorization: "Bearer agk.whatever.secret" },
        payload: { jsonrpc: "2.0", id: "infra-fault-probe", method: "tools/list", _meta: { protocolVersion: "2026-07-28" } },
      });

      const body = JSON.parse(res.body);
      expect(body.error.code).toBe(-32002);
      expect(body.error.code).not.toBe(-32603);
      expect(body.error.code).not.toBe(-32009);
      spy.mockRestore();
    });

    it("REGRESSION — an unknown keyId (a genuine identity decision) still maps to -32009", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: { authorization: "Bearer agk.never-issued.whatever" },
        payload: { jsonrpc: "2.0", id: "req", method: "tools/list", _meta: { protocolVersion: "2026-07-28" } },
      });
      expect(JSON.parse(res.body).error.code).toBe(-32009);
    });

    it("proves this affects tools/list too, not only tools/call (Finding F2)", async () => {
      const spy = vi.spyOn(agentRepository, "findByKeyIdWithTenantContext").mockRejectedValue(new Error("ECONNRESET"));
      const res = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: { authorization: "Bearer agk.whatever.secret" },
        payload: { jsonrpc: "2.0", id: "req-2", method: "tools/list", _meta: { protocolVersion: "2026-07-28" } },
      });
      expect(JSON.parse(res.body).error.code).toBe(-32002);
      spy.mockRestore();
    });
  });
});

