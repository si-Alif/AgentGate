import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  mcpRequestEnvelopeSchema,
  jsonRpcEnvelopeShapeSchema,
  SUPPORTED_PROTOCOL_VERSION,
} from "../../src/mcp/schemas/mcp-envelope.schema.js";
import {
  signalToError,
  McpGatewayError,
  formatMcpErrorResponse,
  ErrorSignal,
} from "../../src/mcp/errors/mcp-error-taxonomy.js";
import { AjvValidatorCache } from "../../src/mcp/cache/ajv-validator-cache.js";
import { toolRepository } from "../../src/repositories/tool.repository.js";

describe("Day 1 Foundational Contracts", () => {
  // ──────────── Envelope Validation ──────────────
  describe("MCP Envelope Schema", () => {
    const validBase = {
      jsonrpc: "2.0" as const,
      id: "req_1",
      method: "tools/call",
      params: {},
      _meta: { protocolVersion: SUPPORTED_PROTOCOL_VERSION },
    };

    it("accepts a valid request with correct protocol version", () => {
      expect(mcpRequestEnvelopeSchema.safeParse(validBase).success).toBe(true);
    });

    it("rejects structurally invalid envelope (missing _meta) as shape failure", () => {
      const invalid = { jsonrpc: "2.0", id: 1, method: "tools/call" };
      expect(jsonRpcEnvelopeShapeSchema.safeParse(invalid).success).toBe(false);
    });

    it("rejects unsupported protocol version after shape is valid", () => {
      const wrong = { ...validBase, _meta: { protocolVersion: "2025-11-25" } };
      const shape = jsonRpcEnvelopeShapeSchema.safeParse(wrong);
      expect(shape.success).toBe(true);
      const full = mcpRequestEnvelopeSchema.safeParse(wrong);
      expect(full.success).toBe(false);
      if (!full.success) {
        const issue = full.error.issues[0];
        expect(issue?.path).toContain("_meta");
        expect(issue?.path).toContain("protocolVersion");
      }
    });
  });

  // ──────────── Error Taxonomy ──────────────
  describe("Error Taxonomy", () => {
    it("maps every known signal to the exact code from §6", () => {
      expect(signalToError("PERMISSION_DENIED")).toEqual({ code: -32000, message: expect.any(String) });
      expect(signalToError("RATE_LIMITED")).toEqual({ code: -32001, message: expect.any(String) });
      expect(signalToError("SERVICE_DEGRADED")).toEqual({ code: -32002, message: expect.any(String) });
      expect(signalToError("TOOL_NOT_FOUND")).toEqual({ code: -32003, message: expect.any(String) });
      expect(signalToError("TOOL_EXECUTION_ERROR")).toEqual({ code: -32004, message: expect.any(String) });
      expect(signalToError("TOOL_EXECUTION_TIMEOUT")).toEqual({ code: -32005, message: expect.any(String) });
      expect(signalToError("PAYLOAD_TOO_LARGE")).toEqual({ code: -32006, message: expect.any(String) });
      expect(signalToError("UNSUPPORTED_MEDIA_TYPE")).toEqual({ code: -32007, message: expect.any(String) });
      expect(signalToError("SSRF_BLOCKED")).toEqual({ code: -32008, message: expect.any(String) });
      expect(signalToError("IDENTITY_INVALID")).toEqual({ code: -32009, message: expect.any(String) });
      expect(signalToError("MESSAGE_RATE_LIMITED")).toEqual({ code: -32010, message: expect.any(String) });
      expect(signalToError("UNSUPPORTED_PROTOCOL_VERSION")).toEqual({ code: -32011, message: expect.any(String) });
    });

    it("no known signal maps to -32603 (INTERNAL_ERROR)", () => {
      const signals = Object.keys(ErrorSignal) as Array<keyof typeof ErrorSignal>;
      for (const sig of signals) {
        if (sig === "INTERNAL_ERROR") continue;
        const { code } = signalToError(sig);
        expect(code).not.toBe(-32603);
      }
    });

    it("McpGatewayError.fromSignal constructs the right error object", () => {
      const err = McpGatewayError.fromSignal("TOOL_NOT_FOUND", { toolId: "tX" });
      expect(err.code).toBe(-32003);
      expect(err.message).toContain("not found");
      expect(err.data).toEqual({ toolId: "tX" });
    });

    it("formatMcpErrorResponse delegates to signalToError for unknown errors", () => {
      const resp = formatMcpErrorResponse(new Error("boom"), "r1");
      expect(resp.error.code).toBe(-32603);
      expect(resp.error.message).toBe(signalToError("INTERNAL_ERROR").message);
    });
  });

  // ──────────── AJV LRU Cache ──────────────
  describe("AJV Validator Cache", () => {
    let cache: AjvValidatorCache;

    beforeEach(() => {
      cache = new AjvValidatorCache(2);
    });

    const schemaA = { type: "object", required: ["x"] };
    const schemaB = { type: "object", required: ["y"] };
    const schemaC = { type: "object" };

    it("returns the identical compiled function for repeated toolId", () => {
      const v1 = cache.getOrCompile("a", schemaA);
      const v2 = cache.getOrCompile("a", schemaA);
      expect(v1).toBe(v2);
    });

    it("evicts least‑recently‑used entry and recompiles on access", () => {
      // Fill cache
      cache.getOrCompile("a", schemaA);
      cache.getOrCompile("b", schemaB);
      expect(cache.size).toBe(2);

      // Access "a" to make it most recent
      cache.getOrCompile("a", schemaA); // LRU refresh

      // Insert "c" – should evict "b" (the LRU)
      cache.getOrCompile("c", schemaC);
      expect(cache.size).toBe(2);

      // Spy on compile to verify a fresh compilation occurs
      const compileSpy = vi.spyOn(cache["ajv"], "compile");

      // Request "b" again
      const bAgain = cache.getOrCompile("b", schemaB);

      // "b" was evicted, so our LRU map must delegate back to Ajv
      expect(compileSpy).toHaveBeenCalled();

      // The returned function is now cached
      const bAgain2 = cache.getOrCompile("b", schemaB);
      expect(bAgain2).toBe(bAgain);

      compileSpy.mockRestore();
    });

    it("handles compile failure gracefully", () => {
      const badSchema = { $ref: "#/nonexistent" };
      expect(() => cache.getOrCompile("fail", badSchema)).toThrow(McpGatewayError);
    });
  });

  // ──────────── Tenant‑Isolated findByName ──────────────
  describe("toolRepository.findByName — tenant isolation", () => {
    it("exists on the repository with the correct signature", () => {
      expect(typeof toolRepository.findByName).toBe("function");
    });

    it("passes tenantId and name as the composite unique key", async () => {
      const fakeDb = {
        tool: { findUnique: vi.fn().mockResolvedValue(null) },
      } as any;
      await toolRepository.findByName("myTool", "tenant_42", fakeDb);
      expect(fakeDb.tool.findUnique).toHaveBeenCalledWith({
        where: { tenantId_name: { tenantId: "tenant_42", name: "myTool" } },
      });
    });
  });
});