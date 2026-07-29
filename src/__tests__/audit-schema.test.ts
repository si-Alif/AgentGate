import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { auditJobPayloadSchema, isInvocationShapedEvent } from "../lib/audit-schema.js";

const validToolInvocation = {
  id: crypto.randomUUID(),
  schemaVersion: 1 as const,
  eventType: "TOOL_INVOCATION" as const,
  tenantId: "tenant-1",
  agentId: "agent-1",
  toolId: "tool-1",
  status: "success" as const,
  durationMs: 42,
  startedAt: new Date(),
  completedAt: new Date(),
  timestamp: new Date(),
  inputTruncated: false,
  outputTruncated: false,
};

describe("auditJobPayloadSchema", () => {
  it("accepts a well-formed TOOL_INVOCATION payload", () => {
    const result = auditJobPayloadSchema.safeParse(validToolInvocation);
    expect(result.success).toBe(true);
  });

  it("rejects a payload with an unrecognized eventType", () => {
    const result = auditJobPayloadSchema.safeParse({ ...validToolInvocation, eventType: "MADE_UP" });
    expect(result.success).toBe(false);
  });

  it("rejects a TOOL_INVOCATION payload missing durationMs", () => {
    const { durationMs, ...rest } = validToolInvocation;
    const result = auditJobPayloadSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("accepts the PERMISSION_DENIED stub shape (unwired, but validates)", () => {
    const result = auditJobPayloadSchema.safeParse({
      ...validToolInvocation,
      eventType: "PERMISSION_DENIED",
      status: "denied",
      denialReason: "tenant_suspended",
    });
    expect(result.success).toBe(true);
  });

  it("rejects AGENT_AUTHENTICATED if it incorrectly carries invocation-only fields as required (toolId absent is fine — it's not invocation-shaped)", () => {
    const result = auditJobPayloadSchema.safeParse({
      id: crypto.randomUUID(),
      schemaVersion: 1,
      eventType: "AGENT_AUTHENTICATED",
      tenantId: "tenant-1",
      agentId: "agent-1",
      timestamp: new Date(),
    });
    expect(result.success).toBe(true);
  });
});

describe("isInvocationShapedEvent", () => {
  it("returns true for TOOL_INVOCATION, PERMISSION_DENIED, RATE_LIMITED", () => {
    expect(isInvocationShapedEvent(validToolInvocation)).toBe(true);
    expect(
      isInvocationShapedEvent({ ...validToolInvocation, eventType: "PERMISSION_DENIED", status: "denied", denialReason: "x" } as any)
    ).toBe(true);
    expect(isInvocationShapedEvent({ ...validToolInvocation, eventType: "RATE_LIMITED", status: "rate_limited" } as any)).toBe(true);
  });

  it("returns false for AGENT_AUTHENTICATED", () => {
    expect(
      isInvocationShapedEvent({
        id: crypto.randomUUID(),
        schemaVersion: 1,
        eventType: "AGENT_AUTHENTICATED",
        tenantId: "t",
        agentId: "a",
        timestamp: new Date(),
      } as any)
    ).toBe(false);
  });
});
