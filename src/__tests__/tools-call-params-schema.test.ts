import { describe, it, expect } from "vitest";
import { toolsCallParamsSchema } from "../mcp/tools/tools-call-params.schema.js";

describe("toolsCallParamsSchema", () => {
  it("accepts a well-formed {name, arguments} payload", () => {
    const result = toolsCallParamsSchema.safeParse({ name: "my-tool", arguments: { q: "hi" } });
    expect(result.success).toBe(true);
  });

  it("defaults arguments to {} when omitted", () => {
    const result = toolsCallParamsSchema.safeParse({ name: "my-tool" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.arguments).toEqual({});
  });

  it("rejects a missing name", () => {
    expect(toolsCallParamsSchema.safeParse({ arguments: {} }).success).toBe(false);
  });

  it("rejects an empty-string name", () => {
    expect(toolsCallParamsSchema.safeParse({ name: "" }).success).toBe(false);
  });
});