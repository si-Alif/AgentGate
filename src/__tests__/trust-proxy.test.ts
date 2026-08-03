import { describe, it, expect, afterAll } from "vitest";
import { createApp } from "../app.js";
import { env } from "../config/env.js";

describe("Fastify trustProxy configuration — Week 7 Day 6, Finding F1 / Decision 7.69", () => {
  const ORIGINAL_HOPS = env.AGENTGATE_TRUST_PROXY_HOPS;
  afterAll(() => { (env as any).AGENTGATE_TRUST_PROXY_HOPS = ORIGINAL_HOPS; });

  it("GATE — with AGENTGATE_TRUST_PROXY_HOPS=0 (default), request.ip ignores X-Forwarded-For entirely (spoofing has no effect)", async () => {
    (env as any).AGENTGATE_TRUST_PROXY_HOPS = 0;
    const app = await createApp();
    const seenIps: string[] = [];
    app.addHook("onRequest", async (request) => { seenIps.push(request.ip); });

    await app.inject({ method: "GET", url: "/healthcheck", headers: { "x-forwarded-for": "203.0.113.9" } });
    await app.inject({ method: "GET", url: "/healthcheck", headers: { "x-forwarded-for": "198.51.100.4" } });

    // Both resolve to the SAME loopback address — the header is
    // completely ignored, which is the SAFE default for a non-proxied
    // deployment (an attacker cannot spoof their apparent IP).
    expect(new Set(seenIps).size).toBe(1);
    await app.close();
  });

  it("GATE — with AGENTGATE_TRUST_PROXY_HOPS=1 (single reverse-proxy hop), request.ip correctly resolves the REAL client address from X-Forwarded-For, not the proxy's", async () => {
    (env as any).AGENTGATE_TRUST_PROXY_HOPS = 1;
    const app = await createApp();
    const seenIps: string[] = [];
    app.addHook("onRequest", async (request) => { seenIps.push(request.ip); });

    await app.inject({ method: "GET", url: "/healthcheck", headers: { "x-forwarded-for": "203.0.113.9" } });
    await app.inject({ method: "GET", url: "/healthcheck", headers: { "x-forwarded-for": "198.51.100.4" } });

    expect(seenIps[0]).toBe("203.0.113.9");
    expect(seenIps[1]).toBe("198.51.100.4");
    expect(seenIps[0]).not.toBe(seenIps[1]); // two distinct clients now correctly distinguished
    await app.close();
  });

  it("a request with NO X-Forwarded-For header still resolves to a sane local address, even with hops configured (no crash on absent header)", async () => {
    (env as any).AGENTGATE_TRUST_PROXY_HOPS = 1;
    const app = await createApp();
    const res = await app.inject({ method: "GET", url: "/healthcheck" });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});