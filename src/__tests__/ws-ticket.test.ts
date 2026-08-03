import { describe, it, expect, vi } from "vitest";
import crypto from "node:crypto";
import { mintWsTicket, ticketKey , redeemWsTicket } from "../observability/ws-ticket.js";
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

describe("redeemWsTicket", () => {
  it("returns the exact identity payload for a freshly minted ticket", async () => {
    const payload = identity({ role: "owner" });
    const { ticket } = await mintWsTicket(payload);
    const redeemed = await redeemWsTicket(ticket);
    expect(redeemed).toEqual(payload);
  });

  it("GATE — redemption consumes the ticket: a second redemption returns null", async () => {
    const { ticket } = await mintWsTicket(identity());
    const first = await redeemWsTicket(ticket);
    const second = await redeemWsTicket(ticket);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it("GATE — two truly CONCURRENT redemptions of the SAME ticket: exactly one wins", async () => {
    const { ticket } = await mintWsTicket(identity());
    const [a, b] = await Promise.all([redeemWsTicket(ticket), redeemWsTicket(ticket)]);
    const results = [a, b];
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect(results.filter((r) => r === null)).toHaveLength(1);
  });

  it("a ticket that was never minted returns null, not a throw", async () => {
    await expect(redeemWsTicket(`agk-never-minted-${crypto.randomUUID()}`)).resolves.toBeNull();
  });

  it("GATE — a Redis error during redemption is THROWN, never swallowed into null (Finding F1)", async () => {
    const { ticket } = await mintWsTicket(identity());
    const spy = vi.spyOn(rateLimiterRedis, "getdel").mockRejectedValue(new Error("ECONNRESET"));
    await expect(redeemWsTicket(ticket)).rejects.toThrow("ECONNRESET");
    spy.mockRestore();
  });
});