import { describe, it, expect } from "vitest";
import {
  generateApiKey,
  parseApiKey,
  hashApiKeySecret,
  verifyApiKeySecret,
} from "../lib/api-key.js";

describe("generateApiKey / parseApiKey", () => {
  it("round-trips: parsing a generated key recovers the same keyId and secret", () => {
    const generated = generateApiKey();
    const parsed = parseApiKey(generated.fullKey);
    expect(parsed).not.toBeNull();
    expect(parsed!.keyId).toBe(generated.keyId);
    expect(parsed!.secret).toBe(generated.rawSecret);
  });

  it("is robust across many generations (catches the base64url '_' edge case)", () => {
    // base64url output can legitimately contain "_" in either segment.
    // If the parser ever regresses to splitting on "_", this loop
    // will eventually generate a key that fails to round-trip.
    for (let i = 0; i < 500; i++) {
      const generated = generateApiKey();
      const parsed = parseApiKey(generated.fullKey);
      expect(parsed).toEqual({
        keyId: generated.keyId,
        secret: generated.rawSecret,
      });
    }
  });

  it("rejects tokens with the wrong prefix", () => {
    expect(parseApiKey("nope.abc.def")).toBeNull();
  });

  it("rejects malformed tokens (wrong segment count)", () => {
    expect(parseApiKey("agk.onlyonepart")).toBeNull();
    expect(parseApiKey("agk.a.b.c")).toBeNull();
  });
});

describe("hashApiKeySecret / verifyApiKeySecret", () => {
  it("verifies a correctly hashed secret", async () => {
    const { rawSecret } = generateApiKey();
    const hash = await hashApiKeySecret(rawSecret);
    await expect(verifyApiKeySecret(hash, rawSecret)).resolves.toBe(true);
  });

  it("rejects an incorrect secret", async () => {
    const a = generateApiKey();
    const b = generateApiKey();
    const hash = await hashApiKeySecret(a.rawSecret);
    await expect(verifyApiKeySecret(hash, b.rawSecret)).resolves.toBe(false);
  });
});