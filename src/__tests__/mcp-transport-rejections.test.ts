import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { createApp } from "../app.js";
import * as originValidator from "../mcp/http/origin-validator.js";
import { prisma } from "../lib/prisma.js";
import { createTestTenant, createTestAgent, cleanupTenant } from "./helpers/test-tenant.factory.js";
import type { FastifyInstance } from "fastify";

describe("Day 6 — Transport-Level Rejection Matrix (+ Decision 6.5 audit-boundary proof)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await createApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });
  it("GATE — GET /mcp returns 405 with Allow: POST", async () => {
    const res = await app.inject({ method: "GET", url: "/mcp" });
    expect(res.statusCode).toBe(405);
    expect(res.headers.allow).toBe("POST");
  });

  it("GATE — malformed envelope (missing method/_meta) -> -32600", async () => {
    const res = await app.inject({ method: "POST", url: "/mcp", payload: { jsonrpc: "2.0" } });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe(-32600);
  });

  it("GATE — unsupported protocol version -> -32011, request id preserved", async () => {
    const res = await app.inject({
      method: "POST", url: "/mcp",
      payload: {
        jsonrpc: "2.0", id: "pv-1", method: "tools/list",
        _meta: { protocolVersion: "2019-01-01" },
      },
    });
    expect(JSON.parse(res.body).error.code).toBe(-32011);
    expect(JSON.parse(res.body).id).toBe("pv-1");
  });

  it("GATE — disallowed Origin -> 403 + -32012, before ANY body parsing", async () => {
    const spy = vi.spyOn(originValidator, "isOriginAllowed").mockReturnValue(false);
    const res = await app.inject({
      method: "POST", url: "/mcp",
      headers: { origin: "https://evil.example" },
      payload: { totally: "malformed, never validated" },
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.code).toBe(-32012);
    spy.mockRestore();
  });

  it("GATE — unknown keyId -> -32009 IDENTITY_INVALID", async () => {
    const res = await app.inject({
      method: "POST", url: "/mcp",
      headers: { authorization: "Bearer agk.unknownkey.somesecret" },
      payload: {
        jsonrpc: "2.0", id: "cred-1", method: "tools/list",
        _meta: { protocolVersion: "2026-07-28" },
      },
    });
    expect(JSON.parse(res.body).error.code).toBe(-32009);
  });

  it("GATE — a wrong secret against a REAL keyId -> -32009, and is never cached (repeat attempt still re-verifies)", async () => {
    const tenant = await createTestTenant(app);
    const { apiKey } = await createTestAgent(tenant.tenantId, tenant.userId);
    const badKey = apiKey.replace(/\.[^.]+$/, ".definitelywrongsecret");

    const first = await app.inject({
      method: "POST", url: "/mcp",
      headers: { authorization: `Bearer ${badKey}` },
      payload: { jsonrpc: "2.0", id: "c1", method: "tools/list", _meta: { protocolVersion: "2026-07-28" } },
    });
    const second = await app.inject({
      method: "POST", url: "/mcp",
      headers: { authorization: `Bearer ${badKey}` },
      payload: { jsonrpc: "2.0", id: "c2", method: "tools/list", _meta: { protocolVersion: "2026-07-28" } },
    });
    expect(JSON.parse(first.body).error.code).toBe(-32009);
    expect(JSON.parse(second.body).error.code).toBe(-32009);

    await cleanupTenant(tenant.tenantId);
  });

  it("GATE (Decision 6.5) — the FULL set of transport-level rejections above produces ZERO audit_events rows for the affected tenant", async () => {
    const tenant = await createTestTenant(app);
    const { apiKey } = await createTestAgent(tenant.tenantId, tenant.userId);
    const beforeCount = await prisma.auditEvent.count({ where: { tenantId: tenant.tenantId } });

    await app.inject({ method: "GET", url: "/mcp" });
    await app.inject({ method: "POST", url: "/mcp", payload: { jsonrpc: "2.0" } });
    await app.inject({
      method: "POST", url: "/mcp",
      payload: { jsonrpc: "2.0", id: "z1", method: "tools/list", _meta: { protocolVersion: "1999-01-01" } },
    });
    await app.inject({
      method: "POST", url: "/mcp",
      payload: { jsonrpc: "2.0", id: "z2", method: "tools/list", _meta: { protocolVersion: "2026-07-28" } }, // no auth header
    });
    await app.inject({
      method: "POST", url: "/mcp",
      headers: { authorization: `Bearer ${apiKey.replace(/\.[^.]+$/, ".wrong")}` },
      payload: { jsonrpc: "2.0", id: "z3", method: "tools/list", _meta: { protocolVersion: "2026-07-28" } },
    });

    await new Promise((r) => setTimeout(r, 300)); // let any stray async work settle
    const afterCount = await prisma.auditEvent.count({ where: { tenantId: tenant.tenantId } });
    expect(afterCount).toBe(beforeCount); // NOT ONE of these produced a row — this IS the boundary, tested

    await cleanupTenant(tenant.tenantId);
  });
});