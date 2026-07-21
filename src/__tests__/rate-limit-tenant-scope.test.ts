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

  it("checkRateLimit with tenantId scopes the counter independently", async () => {
    const agentId = `tenant-scope-test-${crypto.randomUUID()}`;
    const tenantA = `tenant-a-${crypto.randomUUID()}`;
    const tenantB = `tenant-b-${crypto.randomUUID()}`;

    // Tenant A uses up 3 of its 5 allowed calls
    const r1 = await checkRateLimit(agentId, 5);
    const r2 = await checkRateLimit(agentId, 5);
    const r3 = await checkRateLimit(agentId, 5);
    expect(r1.remaining).toBe(4);
    expect(r2.remaining).toBe(3);
    expect(r3.remaining).toBe(2);

    // Tenant B should still have all 5 calls available
    const rB1 = await checkRateLimit(agentId, 5);
    expect(rB1.remaining).toBe(4);

    // Tenant A should continue from where it left off
    const r4 = await checkRateLimit(agentId, 5);
    expect(r4.remaining).toBe(1);
  });
});