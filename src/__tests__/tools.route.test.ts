/**
 * ⚠️ ADAPT-BEFORE-RUNNING NOTE (the one file in this set that needs it):
 *
 * These tests hit the real HTTP routes via app.inject(), which means
 * they go through your `authenticate` → `attachTenantContext` →
 * `requireActiveIdentity` hook chain for real — unlike every other
 * Day 6 test file, which calls the service layer directly and never
 * touches Fastify's routing/serialization layer at all.
 *
 * I don't have your /auth/login request/response contract, so instead
 * of guessing field names and shipping something that might not
 * compile, this signs a JWT directly with `app.jwt.sign()` using the
 * payload shape your own app.ts describes for TenantContext:
 * `{ tenantId, userId, role }`. If `attachTenantContext` expects a
 * different payload shape, or `requireActiveIdentity` checks a DB
 * field that `createTestTenant()` doesn't set by default (e.g.
 * `isVerified`), adjust the `signToken()` helper below — the
 * assertions themselves don't need to change.
 *
 * This is the test that specifically proves the Fastify response
 * SCHEMA fix (flat body, no `{ tool: {...} }` wrapper, `required`
 * arrays catching silently-dropped fields) — none of that layer is
 * exercised by calling toolService directly, which is why it's
 * worth having even though it's the least certain file here.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp } from "../app.js";
import { createTestTenant, cleanupTenant } from "./helpers/test-tenant.factory.js";

describe("Tool routes — HTTP-level response shape regression", () => {
  let app: FastifyInstance;
  let tenant: Awaited<ReturnType<typeof createTestTenant>>;
  let token: string;

  function signToken() {
    // attachTenantContext only needs: { tenantId, userId, role }
    return app.jwt.sign({
      tenantId: tenant.tenantId,
      userId: tenant.userId,
      role: "owner",
    });
  }

  beforeAll(async () => {
    app = await createApp();
    await app.ready();
    tenant = await createTestTenant(app);

    // Use the factory-produced access token if available (and keep signToken
    // as a fallback for contract drift).
    token = tenant.accessToken ?? signToken();
  });

  afterAll(async () => {
    await cleanupTenant(tenant.tenantId);
    await app.close();
  });

  it("POST /api/tools returns a FLAT body — no { tool: {...} } wrapper", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/tools",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name: "route-shape-check",
        handlerType: "web_fetch",
        handlerConfig: { handlerType: "web_fetch", url: "https://example.com" },
        inputSchema: { type: "object", properties: {} },
      },
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);

    // REGRESSION: the original response schema wrapped the payload in
    // { tool: {...} } but the service returned it flat — Fastify's
    // serializer would only find fields matching the declared schema
    // shape and would otherwise emit {} for every route.
    expect(body.tool).toBeUndefined();
    expect(body.id).toBeDefined();
    expect(body.name).toBe("route-shape-check");
    expect(body.handlerConfig).toBeUndefined();
  });

  it("GET /api/tools/:id returns a flat body with no handlerConfig", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/tools",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name: "route-get-check",
        handlerType: "postgres",
        handlerConfig: {
          handlerType: "postgres",
          connectionString: "postgresql://user:leaktest@db.example.com/prod",
          query: "SELECT 1",
        },
        inputSchema: { type: "object", properties: {} },
      },
    });
    const { id } = JSON.parse(created.body);

    const response = await app.inject({
      method: "GET",
      url: `/api/tools/${id}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("leaktest");
    const body = JSON.parse(response.body);
    expect(body.id).toBe(id);
    expect(body.handlerConfig).toBeUndefined();
  });

  it("PATCH /api/tools/:id updates via the renamed updateTool method", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/tools",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name: "route-patch-check",
        handlerType: "web_fetch",
        handlerConfig: { handlerType: "web_fetch", url: "https://example.com" },
        inputSchema: { type: "object", properties: {} },
      },
    });
    const { id } = JSON.parse(created.body);

    const response = await app.inject({
      method: "PATCH",
      url: `/api/tools/${id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { description: "updated via PATCH" },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.description).toBe("updated via PATCH");
  });

  it("POST /api/tools rejects a header-key CRLF injection attempt end-to-end", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/tools",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name: "route-crlf-key-check",
        handlerType: "http",
        handlerConfig: {
          handlerType: "http",
          url: "https://example.com",
          method: "GET",
          headers: { "X-Custom\r\nX-Injected": "true" },
        },
        inputSchema: { type: "object", properties: {} },
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it("GET /api/tools/:id returns 404 for a nonexistent tool (not a 500)", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/tools/00000000-0000-0000-0000-000000000000",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(404);
  });
});