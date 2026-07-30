import { describe, it, expect } from "vitest";
import {
  auditListQuerySchema,
  auditCursorSchema,
} from "../lib/audit-read-schemas.js";

describe("auditListQuerySchema", () => {
  it("accepts valid limit and cursor", () => {
    const result = auditListQuerySchema.safeParse({
      limit: "10",
      cursor: "eyJjcmVhdGVkQXQiOjE3MjA5MzYwMDAwMDAsImlkIjoiZTZiOTg3NjUtNGFiYi00Y2JiLWIyZGItMTIzNDU2Nzg5MGFiYyJ9",
    });
    expect(result.success).toBe(true);
    expect(result.data?.limit).toBe(10);
  });

  it("rejects limit > 50", () => {
    expect(auditListQuerySchema.safeParse({ limit: "100" }).success).toBe(false);
  });

  it("rejects unknown eventType", () => {
    expect(
      auditListQuerySchema.safeParse({ eventType: "BOGUS" }).success
    ).toBe(false);
  });
});

describe("auditCursorSchema", () => {
  it("accepts valid epoch ms and uuid", () => {
    const payload = { createdAt: 1720936000000, id: "e6b98765-4abb-4cbb-b2db-123456789abc" };
    expect(auditCursorSchema.safeParse(payload).success).toBe(true);
  });

  it("rejects negative epoch", () => {
    expect(
      auditCursorSchema.safeParse({ createdAt: -1, id: "e6b98765-4abb-4cbb-b2db-123456789abc" }).success
    ).toBe(false);
  });
});