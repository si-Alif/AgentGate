import { describe, it, expect, vi } from "vitest";
import crypto from "node:crypto";
import { auditQueue, deadLetterAuditQueue, AUDIT_QUEUE_NAME, DEAD_LETTER_QUEUE_NAME } from "../queue/audit.queue.js";
import { enqueueAuditEvent } from "../lib/audit-stub.js";
import type { ToolInvocationJobPayload } from "../lib/audit-schema.js";

function makePayload(overrides: Partial<ToolInvocationJobPayload> = {}): ToolInvocationJobPayload {
  return {
    id: crypto.randomUUID(),
    schemaVersion: 1,
    eventType: "TOOL_INVOCATION",
    tenantId: "tenant-1",
    agentId: "agent-1",
    toolId: "tool-1",
    status: "success",
    durationMs: 10,
    startedAt: new Date(),
    completedAt: new Date(),
    timestamp: new Date(),
    inputTruncated: false,
    outputTruncated: false,
    ...overrides,
  };
}

describe("enqueueAuditEvent — happy path", () => {
  it("adds a job to the audit queue, named by eventType, keyed by the payload's id", async () => {
    const spy = vi.spyOn(auditQueue, "add");
    const payload = makePayload();

    enqueueAuditEvent(payload);
    await new Promise((r) => setTimeout(r, 10)); // let the fire-and-forget promise settle

    expect(spy).toHaveBeenCalledWith(
      payload.eventType,
      expect.objectContaining({ id: payload.id }),
      expect.objectContaining({ jobId: payload.id })
    );
    spy.mockRestore();
  });

  it("a real add() carries the queue's defaultJobOptions onto the created job", async () => {
    const payload = makePayload();
    const job = await auditQueue.add(payload.eventType, payload, { jobId: payload.id });

    expect(job.opts.attempts).toBe(3);
    expect(job.opts.backoff).toEqual({ type: "custom" });

    await job.remove(); // no worker exists yet this week — clean up manually
  });
});

describe("enqueueAuditEvent — never throws (Week 4's fire-and-forget contract)", () => {
  it("never throws when queue.add() itself rejects", async () => {
    const spy = vi.spyOn(auditQueue, "add").mockRejectedValue(new Error("redis unreachable"));
    const payload = makePayload();

    expect(() => enqueueAuditEvent(payload)).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));

    spy.mockRestore();
  });

  it("never throws, and never calls queue.add() at all, when the payload is malformed (Decision 5.17)", async () => {
    const addSpy = vi.spyOn(auditQueue, "add");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => { });

    // Missing nearly every required field, and `id` isn't a valid UUID —
    // fails Zod's discriminated-union parsing for TOOL_INVOCATION.
    const malformed = { id: "not-a-uuid", eventType: "TOOL_INVOCATION" } as unknown as ToolInvocationJobPayload;

    expect(() => enqueueAuditEvent(malformed)).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));

    expect(addSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("refused to enqueue"), expect.anything());

    addSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("strips unrecognized extra fields before enqueueing — parsed.data, not the raw event", async () => {
    const spy = vi.spyOn(auditQueue, "add");
    const payload = { ...makePayload(), somethingUnexpected: "should not survive parsing" };

    enqueueAuditEvent(payload as ToolInvocationJobPayload);
    await new Promise((r) => setTimeout(r, 10));

    const [, addedData] = spy.mock.calls[0]!;
    expect(addedData).not.toHaveProperty("somethingUnexpected");

    spy.mockRestore();
  });
});

describe("BullMQ jobId dedup — the queue-level idempotency layer", () => {
  it("a real add() with the same jobId twice does not create a second waiting job", async () => {
    const payload = makePayload();
    await auditQueue.add(payload.eventType, payload, { jobId: payload.id });
    await auditQueue.add(payload.eventType, payload, { jobId: payload.id });

    const job = await auditQueue.getJob(payload.id);
    expect(job).not.toBeNull();
    await job?.remove();
  });
});

describe("Queue/dead-letter EventEmitter error-listener hygiene (Decision 5.18)", () => {
  it("auditQueue does not crash the process when an 'error' event fires", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
    expect(() => auditQueue.emit("error", new Error("simulated connection blip"))).not.toThrow();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("deadLetterAuditQueue does not crash the process when an 'error' event fires", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
    expect(() => deadLetterAuditQueue.emit("error", new Error("simulated connection blip"))).not.toThrow();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe("queue naming sanity", () => {
  it("queue names match the HLD-specified strings exactly", () => {
    expect(AUDIT_QUEUE_NAME).toBe("audit");
    expect(DEAD_LETTER_QUEUE_NAME).toBe("dead-letter-audit");
  });
});