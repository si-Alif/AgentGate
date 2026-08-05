import { describe, it, expect } from "vitest";
import { generateInvitationToken, hashInvitationToken } from "../lib/invitation-token.js";

describe("invitation-token", () => {
  it("generates a high-entropy, base64url token — never crypto.randomUUID()-shaped", () => {
    const token = generateInvitationToken();
    expect(token.length).toBeGreaterThan(30);
    expect(token).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/); // not a UUID shape
  });

  it("hashing is deterministic — the same raw token always hashes identically", () => {
    const token = generateInvitationToken();
    expect(hashInvitationToken(token)).toBe(hashInvitationToken(token));
  });

  it("GATE — two different tokens never collide in hash output across 200 generations", () => {
    const hashes = new Set(Array.from({ length: 200 }, () => hashInvitationToken(generateInvitationToken())));
    expect(hashes.size).toBe(200);
  });
});