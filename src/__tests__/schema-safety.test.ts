import { describe, it, expect } from "vitest";
import { checkSchemaComplexity, scanForUnsafeRegexPatterns } from "../lib/schema-safety.js";

describe("checkSchemaComplexity", () => {
  it("accepts a realistic tool input schema", () => {
    expect(
      checkSchemaComplexity({
        type: "object",
        properties: { query: { type: "string" }, limit: { type: "number" } },
        required: ["query"],
      }).isSafe
    ).toBe(true);
  });

  it("rejects an oversized schema", () => {
    const huge = { type: "object", properties: {} as Record<string, unknown> };
    for (let i = 0; i < 2000; i++) huge.properties[`field_${i}`] = { type: "string", description: "x".repeat(50) };
    expect(checkSchemaComplexity(huge).isSafe).toBe(false);
  });

  it("rejects pathologically deep nesting", () => {
    let deep: any = { type: "string" };
    for (let i = 0; i < 20; i++) deep = { type: "object", properties: { nested: deep } };
    expect(checkSchemaComplexity(deep).isSafe).toBe(false);
  });
});

describe("scanForUnsafeRegexPatterns", () => {
  it("accepts schemas with no patterns", () => {
    expect(scanForUnsafeRegexPatterns({ type: "object", properties: { name: { type: "string" } } }).isSafe).toBe(true);
  });

  it("accepts realistic, isSafe patterns", () => {
    const schema = {
      type: "object",
      properties: {
        email: { type: "string", pattern: "^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$" },
        code: { type: "string", pattern: "^[A-Z]{3}-[0-9]{4}$" },
      },
    };
    expect(scanForUnsafeRegexPatterns(schema).isSafe).toBe(true);
  });

  it("rejects known catastrophic-backtracking patterns", () => {
    expect(scanForUnsafeRegexPatterns({ type: "string", pattern: "^(a+)+$" }).isSafe).toBe(false);
    expect(scanForUnsafeRegexPatterns({ type: "string", pattern: "^(a*)*$" }).isSafe).toBe(false);
  });

  it("catches unsafe patterns nested inside patternProperties keys", () => {
    expect(
      scanForUnsafeRegexPatterns({
        type: "object",
        patternProperties: { "^(a+)+$": { type: "string" } },
      }).isSafe
    ).toBe(false);
  });

  it("rejects a syntactically invalid regex with a distinct message", () => {
    const result = scanForUnsafeRegexPatterns({ type: "string", pattern: "^(unclosed[" });
    expect(result.isSafe).toBe(false);
    expect(result.errors?.[0]).toMatch(/not a syntactically valid regular expression/);
  });

  it("rejects an oversized pattern", () => {
    const result = scanForUnsafeRegexPatterns({ type: "string", pattern: "a".repeat(500) });
    expect(result.isSafe).toBe(false);
  });
});