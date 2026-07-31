import { describe, it, expect } from "vitest";
import { redactSensitiveFields, AUDIT_REDACTION_MAX_DEPTH, AUDIT_REDACTION_MAX_KEYS } from "../lib/object-redaction.js";

describe("redactSensitiveFields", () => {
  it("redacts a key-shaped secret regardless of JSON quoting — THIS is the F1 regression proof", () => {
    const result = redactSensitiveFields({ apiKey: "sk_live_abc123" }) as any;
    expect(result.apiKey).toBe("[REDACTED]");
  });

  it("redacts nested password fields", () => {
    const result = redactSensitiveFields({ user: { password: "hunter2" } }) as any;
    expect(result.user.password).toBe("[REDACTED]");
  });

  it("leaves non-sensitive keys/values untouched", () => {
    const result = redactSensitiveFields({ query: "SELECT 1", limit: 10 }) as any;
    expect(result).toEqual({ query: "SELECT 1", limit: 10 });
  });

  it("still catches an embedded URL credential under a non-obvious key name (leaf-level redactSecrets)", () => {
    const result = redactSensitiveFields({ note: "connect via postgresql://svc:S3cret@host/db" }) as any;
    expect(result.note).not.toContain("S3cret");
  });

  it("bounds depth", () => {
    let deep: any = { value: "leaf" };
    for (let i = 0; i < AUDIT_REDACTION_MAX_DEPTH + 3; i++) deep = { nested: deep };
    const result = redactSensitiveFields(deep);
    expect(JSON.stringify(result)).toContain("REDACTION_DEPTH_EXCEEDED");
  });

  it("bounds key count — proves EVERY key is counted, not once per object (the bug this fixes)", () => {
    const wide: Record<string, string> = {};
    for (let i = 0; i < AUDIT_REDACTION_MAX_KEYS + 50; i++) wide[`field_${i}`] = "value";
    const result = redactSensitiveFields(wide) as any;
    expect(Object.keys(result).length).toBeLessThanOrEqual(AUDIT_REDACTION_MAX_KEYS + 1);
    expect(result._truncated).toBe("[REDACTION_LIMIT_EXCEEDED]");
  });

  it("terminates on a circular object via the depth bound, never stack-overflows", () => {
    const circular: Record<string, unknown> = { name: "loop" };
    circular.self = circular;
    expect(() => redactSensitiveFields(circular)).not.toThrow();
    expect(() => JSON.stringify(redactSensitiveFields(circular))).not.toThrow();
  });

  it("converts Date instances instead of silently losing them", () => {
    const d = new Date("2026-01-01T00:00:00.000Z");
    const result = redactSensitiveFields({ createdAt: d }) as any;
    expect(result.createdAt).toBe("2026-01-01T00:00:00.000Z");
  });
});