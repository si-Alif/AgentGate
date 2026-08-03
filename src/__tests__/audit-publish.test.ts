import { describe, it, expect, vi } from "vitest";
import { publishLiveEvent } from "../lib/audit-publish.js";
import { redis } from "../lib/redis.js";
import crypto from "node:crypto";
import type {
  PermissionDeniedJobPayload,
  ToolInvocationJobPayload,
  RateLimitedJobPayload,
} from "../lib/audit-schema.js";

describe("buildLiveEvent (via publishLiveEvent) — Week 7 Day 6, Finding F2 / Decision 7.70", () => {
  it("GATE — a PERMISSION_DENIED payload's denialReason IS surfaced on the live event", async () => {
    const spy = vi.spyOn(redis, "publish").mockResolvedValue(1);
    const payload: PermissionDeniedJobPayload = {
      id: crypto.randomUUID(), schemaVersion: 1, eventType: "PERMISSION_DENIED",
      tenantId: "tenant-x", agentId: "agent-x", toolId: "tool-x",
      status: "denied", denialReason: "tool_inactive", durationMs: 3,
      startedAt: new Date(), completedAt: new Date(), timestamp: new Date(),
      inputTruncated: false, outputTruncated: false,
    };
    await publishLiveEvent(payload);
    const [, published] = spy.mock.calls[0]!;
    expect(JSON.parse(published as string).denialReason).toBe("tool_inactive");
    spy.mockRestore();
  });

  it("a TOOL_INVOCATION payload never carries a denialReason field", async () => {
    const spy = vi.spyOn(redis, "publish").mockResolvedValue(1);
    const payload: ToolInvocationJobPayload = {
      id: crypto.randomUUID(), schemaVersion: 1, eventType: "TOOL_INVOCATION",
      tenantId: "t", agentId: "a", toolId: "tl", status: "success", durationMs: 1,
      startedAt: new Date(), completedAt: new Date(), timestamp: new Date(),
      inputTruncated: false, outputTruncated: false,
    };
    await publishLiveEvent(payload);
    expect(JSON.parse(spy.mock.calls[0]![1] as string)).not.toHaveProperty("denialReason");
    spy.mockRestore();
  });

  it("a RATE_LIMITED payload never carries a denialReason field either", async () => {
    const spy = vi.spyOn(redis, "publish").mockResolvedValue(1);
    const payload: RateLimitedJobPayload = {
      id: crypto.randomUUID(), schemaVersion: 1, eventType: "RATE_LIMITED",
      tenantId: "t", agentId: "a", toolId: "tl", status: "rate_limited", durationMs: 1,
      startedAt: new Date(), completedAt: new Date(), timestamp: new Date(),
      inputTruncated: false, outputTruncated: false,
    };
    await publishLiveEvent(payload);
    expect(JSON.parse(spy.mock.calls[0]![1] as string)).not.toHaveProperty("denialReason");
    spy.mockRestore();
  });
});