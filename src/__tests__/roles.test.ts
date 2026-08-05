// src/__tests__/roles.test.ts
import { describe, it, expect } from "vitest";
import { isValidRole, VALID_ROLES } from "../lib/roles.js";

describe("isValidRole", () => {
  it("accepts every member of VALID_ROLES", () => {
    for (const role of VALID_ROLES) expect(isValidRole(role)).toBe(true);
  });
  it("rejects an unknown role string and non-string values", () => {
    expect(isValidRole("admin")).toBe(false); // not in MVP scope yet
    expect(isValidRole(undefined)).toBe(false);
    expect(isValidRole(42)).toBe(false);
  });
});