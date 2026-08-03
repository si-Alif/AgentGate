import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { createApp } from "../app.js";
import { rateLimiterRedis } from "../lib/rate-limiter.js";
import * as rateLimiterModule from "../lib/rate-limiter.js";
import { createTestTenant, cleanupTenant } from "./helpers/test-tenant.factory.js";
import { env } from "../config/env.js";

describe("POST /api/observability/ticket", () => {
  let app: Awaited<ReturnType<typeof createApp>>;
  beforeAll(async () => { app = await createApp(); });
  afterAll(async () => { await app.close(); });

  it("issues a ticket for an authenticated user; response is EXACTLY {ticket, expiresInSeconds}", async () => {
    const tenant = await createTestTenant(app);
    const res = await app.inject({
      method: "POST",
      url: "/api/observability/ticket",
      headers: { Authorization: `Bearer ${tenant.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Object.keys(body).sort()).toEqual(["expiresInSeconds", "ticket"]);
    expect(body.expiresInSeconds).toBe(env.AGENTGATE_WS_TICKET_TTL_SECONDS);
    await cleanupTenant(tenant.tenantId);
  });

  it("rejects an unauthenticated request with 401, before any Redis work", async () => {
    const setSpy = vi.spyOn(rateLimiterRedis, "set");
    const res = await app.inject({ method: "POST", url: "/api/observability/ticket" });
    expect(res.statusCode).toBe(401);
    expect(setSpy).not.toHaveBeenCalled();
    setSpy.mockRestore();
  });

  it("GATE — two different users' tickets never collide in keyspace", async () => {
    const tenantA = await createTestTenant(app);
    const tenantB = await createTestTenant(app);
    const [resA, resB] = await Promise.all([
      app.inject({ method: "POST", url: "/api/observability/ticket", headers: { Authorization: `Bearer ${tenantA.accessToken}` } }),
      app.inject({ method: "POST", url: "/api/observability/ticket", headers: { Authorization: `Bearer ${tenantB.accessToken}` } }),
    ]);
    expect(JSON.parse(resA.body).ticket).not.toBe(JSON.parse(resB.body).ticket);
    await cleanupTenant(tenantA.tenantId);
    await cleanupTenant(tenantB.tenantId);
  });

  it("GATE — throttles past AGENTGATE_WS_TICKET_ISSUE_RATE_LIMIT, returns 429 with error:'rate_limited'", async () => {
    const tenant = await createTestTenant(app);
    const limit = env.AGENTGATE_WS_TICKET_ISSUE_RATE_LIMIT;
    let last;
    for (let i = 0; i < limit + 1; i++) {
      last = await app.inject({ method: "POST", url: "/api/observability/ticket", headers: { Authorization: `Bearer ${tenant.accessToken}` } });
    }
    expect(last!.statusCode).toBe(429);
    expect(JSON.parse(last!.body).error).toBe("rate_limited");
    await cleanupTenant(tenant.tenantId);
  });

  it("GATE — a DEGRADED rate-limit result maps to 503, never 429 (Finding F1 / Decision 7.24)", async () => {
    const tenant = await createTestTenant(app);
    const spy = vi.spyOn(rateLimiterModule, "checkRateLimitByNameSpace").mockResolvedValue({
      allowed: false, remaining: 0, degraded: true,
    });
    const res = await app.inject({ method: "POST", url: "/api/observability/ticket", headers: { Authorization: `Bearer ${tenant.accessToken}` } });
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).error).toBe("service_degraded");
    spy.mockRestore();
    await cleanupTenant(tenant.tenantId);
  });

  it("GATE — a ticket-store write failure AFTER a passed rate check also maps to 503, never a fabricated 200", async () => {
    const tenant = await createTestTenant(app);
    const spy = vi.spyOn(rateLimiterRedis, "set").mockRejectedValue(new Error("ECONNRESET"));
    const res = await app.inject({ method: "POST", url: "/api/observability/ticket", headers: { Authorization: `Bearer ${tenant.accessToken}` } });
    expect(res.statusCode).toBe(503);
    spy.mockRestore();
    await cleanupTenant(tenant.tenantId);
  });

  it("the rate-limit identity is tenant-scoped (Finding F8 / Decision 7.31)", async () => {
    const spy = vi.spyOn(rateLimiterModule, "checkRateLimitByNameSpace");
    const tenant = await createTestTenant(app);
    await app.inject({ method: "POST", url: "/api/observability/ticket", headers: { Authorization: `Bearer ${tenant.accessToken}` } });
    expect(spy).toHaveBeenCalledWith(
      "ws-ticket",
      `${tenant.tenantId}:${tenant.userId}`,
      env.AGENTGATE_WS_TICKET_ISSUE_RATE_LIMIT
    );
    spy.mockRestore();
    await cleanupTenant(tenant.tenantId);
  });
});