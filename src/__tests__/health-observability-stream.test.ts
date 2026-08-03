import { describe, it, expect, vi } from "vitest";
import { createApp } from "../app.js";
import { tenantEventSubscriber } from "../observability/ws-tenant-registry.js";

describe("GET /health — observabilityStream (Week 7 Day 5, Decision 7.68)", () => {
  it("includes a structurally correct, distinct observabilityStream field", async () => {
    const app = await createApp();
    const res = await app.inject({ method: "GET", url: "/healthcheck" });
    const body = JSON.parse(res.body);

    expect(body.observabilityStream).toBeDefined();
    expect(body.observabilityStream).not.toEqual(body.rateLimiter); // NOT a shared-signal alias like mcpGatewayCache
    expect(body.observabilityStream).toHaveProperty("healthy");
    expect(body.observabilityStream).toHaveProperty("reason");
    expect(body.observabilityStream).toHaveProperty("subscribedTenantCount");
    expect(body.observabilityStream).toHaveProperty("totalViewerCount");

    await app.close();
  });

  it("GATE — forcing the subscriber PING down is reflected in observabilityStream, WITHOUT flipping /healthcheck's top-level 200 status", async () => {
    const app = await createApp();
    const spy = vi.spyOn(tenantEventSubscriber, "ping").mockRejectedValue(new Error("ECONNRESET"));

    const res = await app.inject({ method: "GET", url: "/healthcheck" });
    const body = JSON.parse(res.body);

    expect(res.statusCode).toBe(200); // advisory only — Option A posture, same as `audit`
    expect(body.status).toBe("ok");
    expect(body.observabilityStream.healthy).toBe(false);
    expect(body.observabilityStream.reason).toBe("PING_ERROR");

    spy.mockRestore();
    await app.close();
  });

  it("forcing the CORE rate limiter unhealthy still flips /healthcheck to 503, regardless of observabilityStream's own state", async () => {
    const app = await createApp();
    const rateLimiterModule = await import("../lib/rate-limiter.js");
    const breaker = rateLimiterModule.getRateLimiterBreaker();
    breaker.reset();
    breaker.onFailure(); breaker.onFailure(); breaker.onFailure(); // trips OPEN

    const res = await app.inject({ method: "GET", url: "/healthcheck" });
    expect(res.statusCode).toBe(503);

    breaker.reset();
    await app.close();
  });
});