import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { auditJobPayloadSchema } from "../lib/audit-schema.js";

function baseToolInvocation(overrides: Record<string, unknown> = {}) {
  return {
    id: crypto.randomUUID(),
    schemaVersion: 1,
    eventType: "TOOL_INVOCATION",
    tenantId: "tenant-1",
    agentId: "agent-1",
    toolId: "tool-1",
    status: "success",
    durationMs: 42,
    startedAt: new Date(),
    completedAt: new Date(),
    timestamp: new Date(),
    inputTruncated: false,
    outputTruncated: false,
    ...overrides,
  };
}

describe("auditJobPayloadSchema — gatewayOverheadMs (Day 5, additive)", () => {
  it("REGRESSION — a payload written before this field existed still parses (no schemaVersion bump)", () => {
    const result = auditJobPayloadSchema.safeParse(baseToolInvocation());
    expect(result.success).toBe(true);
  });

  it("accepts a valid TOOL_INVOCATION payload WITH gatewayOverheadMs, and the value round-trips exactly", () => {
    const result = auditJobPayloadSchema.safeParse(baseToolInvocation({ gatewayOverheadMs: 17 }));
    expect(result.success).toBe(true);
    if (result.success && result.data.eventType === "TOOL_INVOCATION") {
      expect(result.data.gatewayOverheadMs).toBe(17);
    }
  });

  it("rejects a negative gatewayOverheadMs", () => {
    expect(auditJobPayloadSchema.safeParse(baseToolInvocation({ gatewayOverheadMs: -1 })).success).toBe(false);
  });

  it("a PERMISSION_DENIED payload with a spurious gatewayOverheadMs is accepted (Zod strips unknown keys by default) — confirms nothing breaks, not that the field is meaningful there", () => {
    const payload = {
      id: crypto.randomUUID(),
      schemaVersion: 1,
      eventType: "PERMISSION_DENIED",
      tenantId: "t",
      agentId: "a",
      toolId: "tl",
      status: "denied",
      denialReason: "not_found",
      durationMs: 5,
      startedAt: new Date(),
      completedAt: new Date(),
      timestamp: new Date(),
      inputTruncated: false,
      outputTruncated: false,
      gatewayOverheadMs: 999, // not a real field on this schema — should simply be stripped
    };
    const result = auditJobPayloadSchema.safeParse(payload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).gatewayOverheadMs).toBeUndefined();
    }
  });
});