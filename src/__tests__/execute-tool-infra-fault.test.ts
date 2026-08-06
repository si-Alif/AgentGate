import { describe, it, expect, vi } from "vitest";
import { executeTool } from "../lib/execute-tool.js";
import { toolRepository } from "../repositories/tool.repository.js";

describe("executeTool — INFRA_UNAVAILABLE (Week 8 Day 4, Finding F1 / Decision 8.81)", () => {
  it("GATE — a raw DB fault during the tool lookup maps to errorCode INFRA_UNAVAILABLE, never HANDLER_ERROR", async () => {
    const spy = vi.spyOn(toolRepository, "findById").mockRejectedValue(new Error("ECONNRESET: connection terminated"));

    const result = await executeTool("tool-x", "tenant-y", "agent-z", {}, new AbortController().signal);

    expect(result.status).toBe("error");
    expect(result.errorCode).toBe("INFRA_UNAVAILABLE");
    expect(result.errorCode).not.toBe("HANDLER_ERROR");

    spy.mockRestore();
  });

  it("a genuine, already-classified fault (TOOL_NOT_FOUND) is unaffected — proves the new guard is scoped to the DB call, not the whole function", async () => {
    const spy = vi.spyOn(toolRepository, "findById").mockResolvedValue(null);
    const result = await executeTool("tool-x", "tenant-y", "agent-z", {}, new AbortController().signal);
    expect(result.errorCode).toBe("TOOL_NOT_FOUND");
    spy.mockRestore();
  });

  it("a genuine handler-dispatch-level failure (e.g. a bad decrypt) still maps to its own existing code, unaffected by today's change", async () => {
    const spy = vi.spyOn(toolRepository, "findById").mockResolvedValue({
      id: "tool-x", tenantId: "tenant-y", isActive: true, handlerConfig: "not-a-valid-envelope",
    } as any);
    const result = await executeTool("tool-x", "tenant-y", "agent-z", {}, new AbortController().signal);
    expect(result.errorCode).toBe("DECRYPTION_FAILED");
    spy.mockRestore();
  });
});