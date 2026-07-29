import { describe, it, expect } from "vitest";
import { capturePreview, AUDIT_PREVIEW_MAX_BYTES } from "../lib/audit-preview.js";

describe("capturePreview", () => {
  it("returns undefined preview, untruncated, for an undefined value", () => {
    expect(capturePreview(undefined)).toEqual({ preview: undefined, truncated: false });
  });

  it("passes small values through untruncated", () => {
    const result = capturePreview({ query: "SELECT 1" });
    expect(result.truncated).toBe(false);
    expect(result.preview).toEqual({ query: "SELECT 1" });
  });

  it("redacts known-sensitive keys before capping", () => {
    const result = capturePreview({ connectionString: "postgresql://user:s3cr3t@host/db", query: "SELECT 1" });
    expect(JSON.stringify(result.preview)).not.toContain("s3cr3t");
  });

  it("truncates a value whose serialized form exceeds the byte ceiling", () => {
    const huge = { blob: "x".repeat(AUDIT_PREVIEW_MAX_BYTES * 2) };
    const result = capturePreview(huge);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result.preview), "utf-8")).toBeLessThan(AUDIT_PREVIEW_MAX_BYTES + 200);
  });
});