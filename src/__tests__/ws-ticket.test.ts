import { describe, it, expect, vi } from "vitest";
import crypto from "node:crypto";
import { mintWsTicket, ticketKey } from "../observability/ws-ticket.js";
import { rateLimiterRedis } from "../lib/rate-limiter.js";

type Role = "member" | "owner" | "admin";

function identity(overrides: Partial<{ userId: string; tenantId: string; role: Role }> = {}) {
  return { userId: crypto.randomUUID(), tenantId: crypto.randomUUID(), role: "member" as Role , ...overrides };
}

describe("mintWsTicket", () => {
  it("returns a ticket string and the configured TTL", async () => {
    const result = await mintWsTicket(identity());
    expect(typeof result.ticket).toBe("string");
    expect(result.ticket.length).toBeGreaterThan(20); // 32 random bytes, base64url-encoded
    expect(result.expiresInSeconds).toBe(30); // AGENTGATE_WS_TICKET_TTL_SECONDS default
  });

  it("persists the exact identity payload under ticketKey(ticket)", async () => {
    const person = identity({ role: "owner" });
    const { ticket } = await mintWsTicket(person);
    const raw = await rateLimiterRedis.get(ticketKey(ticket));
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toEqual(person);
  });

  it("GATE — does NOT store a redundant mint-timestamp field alongside the identity (Finding F4)", async () => {
    const { ticket } = await mintWsTicket(identity());
    const raw = await rateLimiterRedis.get(ticketKey(ticket));
    const stored = JSON.parse(raw!);
    expect(Object.keys(stored).sort()).toEqual(["role", "tenantId", "userId"]);
  });

  it("Redis honors the TTL itself — no manual expiry bookkeeping needed", async () => {
    const { ticket } = await mintWsTicket(identity());
    const ttl = await rateLimiterRedis.ttl(ticketKey(ticket));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(30);
  });

  it("GATE — 50 mints for the IDENTICAL identity never collide in keyspace", async () => {
    const person = identity();
    const minted = await Promise.all(Array.from({ length: 50 }, () => mintWsTicket(person)));
    expect(new Set(minted.map((m) => m.ticket)).size).toBe(50);
  });

  it("GATE — a Redis SET failure propagates as a real rejection, never a silently-issued unredeemable ticket", async () => {
    const spy = vi.spyOn(rateLimiterRedis, "set").mockRejectedValue(new Error("ECONNRESET"));
    await expect(mintWsTicket(identity())).rejects.toThrow("ECONNRESET");
    spy.mockRestore();
  });
});