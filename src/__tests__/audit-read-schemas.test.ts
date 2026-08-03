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

describe("auditListQuerySchema — `since` (Week 7 Day 4, Finding F1)", () => {
  it("accepts a valid ISO date string for `since`", () => {
    const result = auditListQuerySchema.safeParse({ since: "2026-08-01T00:00:00.000Z" });
    expect(result.success).toBe(true);
    expect(result.data?.since).toBeInstanceOf(Date);
  });

  it("REGRESSION — omitting `since` is fully backward compatible with every existing caller", () => {
    const result = auditListQuerySchema.safeParse({ limit: 10 });
    expect(result.success).toBe(true);
    expect(result.data?.since).toBeUndefined();
  });

  it("rejects a non-date string", () => {
    expect(auditListQuerySchema.safeParse({ since: "not-a-date" }).success).toBe(false);
  });

  it("composes with cursor and entity filters without conflict", () => {
    const result = auditListQuerySchema.safeParse({
      since: "2026-08-01T00:00:00.000Z",
      eventType: "TOOL_INVOCATION",
      agentId: "agent-1",
    });
    expect(result.success).toBe(true);
  });
});