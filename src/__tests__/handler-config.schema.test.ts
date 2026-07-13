import { describe, it, expect } from "vitest";
import { handlerConfigSchema } from "../lib/handler-config.schema.js";

describe("handlerConfigSchema", () => {
  it("accepts a valid http config", () => {
    const result = handlerConfigSchema.safeParse({
      handlerType: "http",
      url: "https://api.example.com/webhook",
      method: "POST",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a postgres-shaped config declared as http (strict mode)", () => {
    const result = handlerConfigSchema.safeParse({
      handlerType: "http",
      url: "https://api.example.com/webhook",
      method: "POST",
      connectionString: "postgresql://...", // stray field from the other variant
    });
    expect(result.success).toBe(false);
  });

  it("rejects a URL targeting a private/internal address", () => {
    const result = handlerConfigSchema.safeParse({
      handlerType: "http",
      url: "http://169.254.169.254/latest/meta-data/",
      method: "GET",
    });
    expect(result.success).toBe(false);
  });

  it("rejects headers attempting to override Host", () => {
    const result = handlerConfigSchema.safeParse({
      handlerType: "http",
      url: "https://api.example.com/webhook",
      method: "POST",
      headers: { Host: "evil.internal" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects headers containing CRLF", () => {
    const result = handlerConfigSchema.safeParse({
      handlerType: "http",
      url: "https://api.example.com/webhook",
      method: "POST",
      headers: { "X-Custom": "value\r\nX-Injected: true" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a postgres connection string targeting loopback", () => {
    const result = handlerConfigSchema.safeParse({
      handlerType: "postgres",
      connectionString: "postgresql://user:pass@127.0.0.1:5432/prod",
      query: "SELECT 1",
    });
    expect(result.success).toBe(false);
  });
});