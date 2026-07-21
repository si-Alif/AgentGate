import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { rateLimitKey, checkRateLimit } from "../lib/rate-limiter.js";

describe("rateLimitKey — tenant-scoped isolation (Finding #5 fix)", () => {
  it("includes tenantId in the key when provided", () => {
    const key = rateLimitKey("agent-123", "tenant-456");
    expect(key).toContain("tenant:tenant-456");
    expect(key).toContain("agent:agent-123");
  });

  it("falls back to agent-only key when tenantId is omitted", () => {
    const key = rateLimitKey("agent-123");
    expect(key).not.toContain("tenant:");
    expect(key).toBe("rate:agent:agent-123:min:" + Math.floor(Date.now() / 60_000));
  });

  it("two different tenants with the same agentId get different keys", () => {
    const keyA = rateLimitKey("same-agent", "tenant-A");
    const keyB = rateLimitKey("same-agent", "tenant-B");
    expect(keyA).not.toBe(keyB);
  });

  it("checkRateLimit with tenantId scopes the counter independently per tenant", async () => {
    const agentId = `tenant-scope-test-${crypto.randomUUID()}`;
    const tenantA = `tenant-a-${crypto.randomUUID()}`;
    const tenantB = `tenant-b-${crypto.randomUUID()}`;

    const r1 = await checkRateLimit(agentId, 5, tenantA);
    const r2 = await checkRateLimit(agentId, 5, tenantA);
    const r3 = await checkRateLimit(agentId, 5, tenantA);
    expect(r1.remaining).toBe(4);
    expect(r2.remaining).toBe(3);
    expect(r3.remaining).toBe(2);

    const rB1 = await checkRateLimit(agentId, 5, tenantB);
    const rB2 = await checkRateLimit(agentId, 5, tenantB);
    expect(rB1.remaining).toBe(4);
    expect(rB2.remaining).toBe(3);

    const r4 = await checkRateLimit(agentId, 5, tenantA);
    expect(r4.remaining).toBe(1);
  });

  it("legacy key (no tenantId) is independent from tenant-scoped keys", async () => {
    const agentId = `legacy-isolation-test-${crypto.randomUUID()}`;
    const tenantId = `tenant-legacy-${crypto.randomUUID()}`;

    await checkRateLimit(agentId, 5, tenantId);
    await checkRateLimit(agentId, 5, tenantId);
    await checkRateLimit(agentId, 5, tenantId);

    const legacy1 = await checkRateLimit(agentId, 5);
    expect(legacy1.remaining).toBe(4);
  });
});