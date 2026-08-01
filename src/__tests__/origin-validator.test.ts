import { describe, it, expect } from "vitest";
import { isOriginAllowed } from "../mcp/http/origin-validator.js";

describe("isOriginAllowed", () => {
  it("allows an absent Origin regardless of allow-list contents", () => {
    expect(isOriginAllowed(undefined, ["https://example.com"])).toBe(true);
  });

  it("allows any Origin when the allow-list is empty (default posture)", () => {
    expect(isOriginAllowed("https://anything.example", [])).toBe(true);
  });

  it("allows a listed Origin", () => {
    expect(isOriginAllowed("https://good.example", ["https://good.example"])).toBe(true);
  });

  it("rejects an unlisted Origin once the allow-list is non-empty", () => {
    expect(isOriginAllowed("https://evil.example", ["https://good.example"])).toBe(false);
  });
});