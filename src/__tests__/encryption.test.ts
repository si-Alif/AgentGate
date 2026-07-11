import { describe, it, expect } from "vitest";
import { encryptConfig, decryptConfig } from "../lib/encryption.js";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";

describe("encryptConfig / decryptConfig", () => {
  it("round-trips plaintext for the same tenant", () => {
    const plaintext = JSON.stringify({ url: "https://internal.example.com", method: "POST" });
    const stored = encryptConfig(plaintext, TENANT_A);
    expect(stored).not.toContain("internal.example.com"); // not plaintext at rest
    expect(decryptConfig(stored, TENANT_A)).toBe(plaintext);
  });

  it("produces a different ciphertext every time (random IV)", () => {
    const plaintext = "same input twice";
    const first = encryptConfig(plaintext, TENANT_A);
    const second = encryptConfig(plaintext, TENANT_A);
    expect(first).not.toBe(second);
  });

  it("fails to decrypt with a different tenant's derived key", () => {
    const stored = encryptConfig("tenant A's secret connection string", TENANT_A);
    expect(() => decryptConfig(stored, TENANT_B)).toThrow();
  });

  it("detects tampering via the GCM auth tag", () => {
    const stored = encryptConfig("do not touch this", TENANT_A);
    const [iv, ciphertext, authTag] = stored.split(":");

    if (!iv || !ciphertext || !authTag) {
      throw new Error("Malformed ciphertext envelope");
    }

    const tamperedCiphertext = Buffer.from(ciphertext, "base64");
    if (tamperedCiphertext[0] !== undefined) {
      tamperedCiphertext[0] ^= 0xff; // flip a bit
    }
    const tampered = [iv, tamperedCiphertext.toString("base64"), authTag].join(":");
    expect(() => decryptConfig(tampered, TENANT_A)).toThrow();
  });

  it("rejects a malformed envelope", () => {
    expect(() => decryptConfig("not-a-valid-envelope", TENANT_A)).toThrow();
  });
});