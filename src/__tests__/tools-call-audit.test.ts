import { describe, it, expect, vi } from "vitest";
import { auditPermissionDenied, auditRateLimited } from "../mcp/tools/tools-call-audit.js";
import * as auditStub from "../lib/audit-stub.js";
import type { PermissionCheckResult } from "../lib/permission-engine.js";
import type { RateLimitResult } from "../lib/rate-limiter.js";

function ctx(overrides: Partial<Parameters<typeof auditPermissionDenied>[0]> = {}) {
  return {
    tenantId: "tenant-1",
    agentId: "agent-1",
    toolId: "tool-1",
    toolArguments: { q: "hello" },
    requestReceivedAt: new Date(),
    requestStart: performance.now() - 12,
    ...overrides,
  };
}

describe("auditPermissionDenied — Decision 5.3", () => {
  it("enqueues a PERMISSION_DENIED payload for each of the five genuine policy reasons", () => {
    const spy = vi.spyOn(auditStub, "enqueueAuditEvent");
    const reasons: Array<Exclude<Extract<PermissionCheckResult, { granted: false }>["reason"], "error">> = [
      "not_found", "permission_inactive", "tool_inactive", "agent_inactive", "tenant_suspended",
    ];
    for (const reason of reasons) {
      spy.mockClear();
      auditPermissionDenied(ctx(), { granted: false, reason });
      expect(spy).toHaveBeenCalledTimes(1);
      const payload = spy.mock.calls[0]![0] as any;
      expect(payload.eventType).toBe("PERMISSION_DENIED");
      expect(payload.denialReason).toBe(reason);
    }
    spy.mockRestore();
  });

  it("GATE — reason:'error' is NEVER audited, and the raw sensitive exception never touches enqueueAuditEvent", () => {
    const spy = vi.spyOn(auditStub, "enqueueAuditEvent");
    const sensitiveError = new Error("connection string: postgres://admin:S3cret@internal-db/prod");
    auditPermissionDenied(ctx(), { granted: false, reason: "error", error: sensitiveError });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("captures a redacted preview of the attempted tool arguments", () => {
    const spy = vi.spyOn(auditStub, "enqueueAuditEvent");
    auditPermissionDenied(ctx({ toolArguments: { apiKey: "sk_live_shouldnotleak", q: "hi" } }), {
      granted: false, reason: "not_found",
    });
    const payload = spy.mock.calls[0]![0] as any;
    expect(JSON.stringify(payload.inputPreview)).not.toContain("sk_live_shouldnotleak");
    spy.mockRestore();
  });

  it("durationMs reflects elapsed pipeline time, not a hardcoded zero", () => {
    const spy = vi.spyOn(auditStub, "enqueueAuditEvent");
    auditPermissionDenied(ctx({ requestStart: performance.now() - 55 }), { granted: false, reason: "not_found" });
    const payload = spy.mock.calls[0]![0] as any;
    expect(payload.durationMs).toBeGreaterThanOrEqual(50);
    spy.mockRestore();
  });

  it("never throws even if enqueueAuditEvent itself throws synchronously", () => {
    const spy = vi.spyOn(auditStub, "enqueueAuditEvent").mockImplementation(() => {
      throw new Error("simulated queue failure");
    });
    expect(() => auditPermissionDenied(ctx(), { granted: false, reason: "not_found" })).not.toThrow();
    spy.mockRestore();
  });
});

describe("auditRateLimited — Decision 5.4", () => {
  it("enqueues a RATE_LIMITED payload for a genuine (non-degraded) denial", () => {
    const spy = vi.spyOn(auditStub, "enqueueAuditEvent");
    const result: RateLimitResult = { allowed: false, remaining: 0, degraded: false };
    auditRateLimited(ctx(), result);
    expect(spy).toHaveBeenCalledTimes(1);
    expect((spy.mock.calls[0]![0] as any).eventType).toBe("RATE_LIMITED");
    spy.mockRestore();
  });

  it("GATE — a degraded result is NEVER audited as RATE_LIMITED", () => {
    const spy = vi.spyOn(auditStub, "enqueueAuditEvent");
    const result: RateLimitResult = { allowed: false, remaining: 0, degraded: true };
    auditRateLimited(ctx(), result);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("never throws even if capturePreview or ID generation misbehaves", () => {
    const spy = vi.spyOn(auditStub, "enqueueAuditEvent").mockImplementation(() => {
      throw new Error("simulated failure");
    });
    expect(() =>
      auditRateLimited(ctx(), { allowed: false, remaining: 0, degraded: false })
    ).not.toThrow();
    spy.mockRestore();
  });
});