import { describe, it, expect } from "vitest";
import { mapPermissionDenialToError, mapToolExecutionErrorToError } from "../mcp/tools/tools-call-error-mapping.js";
import type { PermissionCheckResult } from "../lib/permission-engine.js";
import type { ToolExecutionErrorCode } from "../handlers/types.js";

function denial(reason: Exclude<PermissionCheckResult, { granted: true }>["reason"], error?: unknown) {
  return { granted: false as const, reason, ...(error !== undefined ? { error } : {}) };
}

describe("mapPermissionDenialToError — exhaustive, all six reasons", () => {
  it("not_found and permission_inactive -> -32000 PERMISSION_DENIED", () => {
    expect(mapPermissionDenialToError(denial("not_found")).code).toBe(-32000);
    expect(mapPermissionDenialToError(denial("permission_inactive")).code).toBe(-32000);
  });

  it("tool_inactive -> -32003 TOOL_NOT_FOUND", () => {
    expect(mapPermissionDenialToError(denial("tool_inactive")).code).toBe(-32003);
  });

  it("agent_inactive and tenant_suspended -> -32009 IDENTITY_INVALID", () => {
    expect(mapPermissionDenialToError(denial("agent_inactive")).code).toBe(-32009);
    expect(mapPermissionDenialToError(denial("tenant_suspended")).code).toBe(-32009);
  });

  it("error -> -32002 SERVICE_DEGRADED", () => {
    expect(mapPermissionDenialToError(denial("error")).code).toBe(-32002);
  });

  it("SECURITY — the raw result.error is NEVER present anywhere in the mapped error's data", () => {
    const sensitiveError = new Error("connection string: postgres://admin:S3cret@internal-db/prod");
    const mapped = mapPermissionDenialToError(denial("error", sensitiveError));
    const serialized = JSON.stringify(mapped.data);
    expect(serialized).not.toContain("S3cret");
    expect(serialized).not.toContain("connection string");
  });

  it("no reason maps to the generic -32603 INTERNAL_ERROR", () => {
    const reasons: Array<Exclude<PermissionCheckResult, { granted: true }>["reason"]> = [
      "not_found", "permission_inactive", "tool_inactive", "agent_inactive", "tenant_suspended", "error",
    ];
    for (const reason of reasons) {
      expect(mapPermissionDenialToError(denial(reason)).code).not.toBe(-32603);
    }
  });
});

describe("mapToolExecutionErrorToError — exhaustive, all nine codes", () => {
  const ALL_CODES: ToolExecutionErrorCode[] = [
    "TOOL_NOT_FOUND", "TOOL_INACTIVE", "DECRYPTION_FAILED", "INVALID_HANDLER_CONFIG",
    "SSRF_BLOCKED", "TIMEOUT", "PAYLOAD_TOO_LARGE", "UNSUPPORTED_MEDIA_TYPE", "HANDLER_ERROR", "INFRA_UNAVAILABLE",
  ];

  it("TOOL_NOT_FOUND and TOOL_INACTIVE share -32003, by design", () => {
    expect(mapToolExecutionErrorToError("TOOL_NOT_FOUND").code).toBe(-32003);
    expect(mapToolExecutionErrorToError("TOOL_INACTIVE").code).toBe(-32003);
  });

  it("DECRYPTION_FAILED, INVALID_HANDLER_CONFIG, HANDLER_ERROR all share -32004 (NOT -32002)", () => {
    expect(mapToolExecutionErrorToError("DECRYPTION_FAILED").code).toBe(-32004);
    expect(mapToolExecutionErrorToError("INVALID_HANDLER_CONFIG").code).toBe(-32004);
    expect(mapToolExecutionErrorToError("HANDLER_ERROR").code).toBe(-32004);
  });

  it("TIMEOUT / PAYLOAD_TOO_LARGE / UNSUPPORTED_MEDIA_TYPE / SSRF_BLOCKED each get their own distinct code", () => {
    expect(mapToolExecutionErrorToError("TIMEOUT").code).toBe(-32005);
    expect(mapToolExecutionErrorToError("PAYLOAD_TOO_LARGE").code).toBe(-32006);
    expect(mapToolExecutionErrorToError("UNSUPPORTED_MEDIA_TYPE").code).toBe(-32007);
    expect(mapToolExecutionErrorToError("SSRF_BLOCKED").code).toBe(-32008);
  });

  it("no code maps to the generic -32603 INTERNAL_ERROR", () => {
    for (const code of ALL_CODES) {
      expect(mapToolExecutionErrorToError(code).code).not.toBe(-32603);
    }
  });

  it("detail (already-redacted ExecutionResult.error) is safely passed through as data.detail", () => {
    const mapped = mapToolExecutionErrorToError("HANDLER_ERROR", "ECONNREFUSED at target");
    expect((mapped.data as any).detail).toBe("ECONNREFUSED at target");
  });
});

describe("mapToolExecutionErrorToError — INFRA_UNAVAILABLE (Week 8 Day 4, Decision 8.81)", () => {
  it("maps to -32002 SERVICE_DEGRADED, never -32004 TOOL_EXECUTION_ERROR", () => {
    expect(mapToolExecutionErrorToError("INFRA_UNAVAILABLE").code).toBe(-32002);
  });
});