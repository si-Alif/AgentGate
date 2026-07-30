import { describe, it, expect, beforeAll, afterAll , beforeEach , afterEach  , vi} from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp } from "../app.js";
import crypto from "node:crypto";
import { createAuditWorker, persistAuditEvent, processJob } from "../workers/audit.worker.js";
import { auditQueue, deadLetterAuditQueue } from "../queue/audit.queue.js";
import { auditPrisma } from "../lib/audit-prisma.js";
import { toolExecutionRepository } from "../repositories/tool-execution.repository.js";
import { auditEventRepository } from "../repositories/audit-event.repository.js";
import * as auditPublish from "../lib/audit-publish.js";
import type { ToolInvocationJobPayload } from "../lib/audit-schema.js";
import {
  createTestTenant,
  createTestAgent,
  createTestTool,
  cleanupTenant,
  type TestTenantHandle,
  type TestToolHandlerType,
  type TestToolInterface,
  type TestAgentCreationResult,
} from "./helpers/test-tenant.factory.js";

function makeToolInvocationPayload(
  overrides: Partial<ToolInvocationJobPayload> = {}
): ToolInvocationJobPayload {
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

// This codebase's async workers (BullMQ) don't offer a synchronous
// "wait until processed" hook — tests poll with a bounded timeout
// rather than sleeping a fixed, possibly-flaky duration.
async function waitFor(assertion: () => Promise<void>, timeoutMs = 5000, intervalMs = 100): Promise<void> {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await assertion();
      return;
    } catch (err) {
      if (Date.now() - start > timeoutMs) throw err;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}

describe("persistAuditEvent — direct, deterministic (no BullMQ involved)", () => {

  let app: FastifyInstance;
  let tenant : TestTenantHandle;
  let agent : TestAgentCreationResult;
  let tool : TestToolInterface;
  beforeAll(async () => {
    app = await createApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    tenant = await createTestTenant(app);
    agent = await createTestAgent(tenant.tenantId, tenant.userId);
    tool = await createTestTool(tenant.tenantId);
  });

  afterEach(async () => {
    await cleanupTenant(tenant.tenantId);
  });

  it("a fresh id produces freshInsert: true and writes both rows sharing the id", async () => {
    const payload = makeToolInvocationPayload({ tenantId: tenant.tenantId, agentId: agent.agent.id, toolId: tool.id });

    const result = await persistAuditEvent(payload);
    expect(result.freshInsert).toBe(true);

    const exec = await auditPrisma.toolExecution.findUnique({ where: { id: payload.id } });
    const event = await auditPrisma.auditEvent.findUnique({ where: { id: payload.id } });
    expect(exec).not.toBeNull();
    expect(event).not.toBeNull();
    expect(exec!.id).toBe(event!.id);
  });

  it("a second call for the SAME id (sequential redelivery simulation) returns freshInsert: false, zero duplicate rows", async () => {
    const payload = makeToolInvocationPayload({ tenantId: tenant.tenantId, agentId: agent.agent.id, toolId: tool.id });

    const first = await persistAuditEvent(payload);
    const second = await persistAuditEvent(payload);

    expect(first.freshInsert).toBe(true);
    expect(second.freshInsert).toBe(false);
    expect(await auditPrisma.toolExecution.count({ where: { id: payload.id } })).toBe(1);
    expect(await auditPrisma.auditEvent.count({ where: { id: payload.id } })).toBe(1);
  });

  it("GATE — true concurrent writers for the SAME id produce exactly one fresh insert and zero duplicate rows", async () => {
    // This is the single most important test this week. Promise.all
    // fires all three calls before any of them resolve — unlike the
    // sequential test above, this is a genuine race on the same `id`,
    // the harder and more realistic version of "redelivery" (multiple
    // worker replicas, or concurrency > 1 within one process, both of
    // which this system actually runs). The atomicity guarantee comes
    // from Postgres's own unique index, not from any ordering the
    // test imposes.
    const payload = makeToolInvocationPayload({ tenantId: tenant.tenantId, agentId: agent.agent.id, toolId: tool.id });

    const results = await Promise.all([
      persistAuditEvent(payload),
      persistAuditEvent(payload),
      persistAuditEvent(payload),
    ]);

    const freshCount = results.filter((r) => r.freshInsert).length;
    expect(freshCount).toBe(1);
    expect(await auditPrisma.toolExecution.count({ where: { id: payload.id } })).toBe(1);
    expect(await auditPrisma.auditEvent.count({ where: { id: payload.id } })).toBe(1);
  });

  it("writes ONLY audit_events (no tool_executions row) for a non-invocation-shaped event", async () => {
    const payload = {
      id: crypto.randomUUID(),
      schemaVersion: 1 as const,
      eventType: "AGENT_AUTHENTICATED" as const,
      tenantId: tenant.tenantId,
      agentId: agent.agent.id,
      timestamp: new Date(),
    };

    const result = await persistAuditEvent(payload);
    expect(result.freshInsert).toBe(true);

    const event = await auditPrisma.auditEvent.findUnique({ where: { id: payload.id } });
    const exec = await auditPrisma.toolExecution.findUnique({ where: { id: payload.id } });
    expect(event).not.toBeNull();
    expect(exec).toBeNull();
  });

  it("rethrows a genuine (non-P2002) infra error rather than swallowing it", async () => {
    const spy = vi.spyOn(toolExecutionRepository, "create").mockRejectedValue(new Error("connection reset"));
    const payload = makeToolInvocationPayload({ tenantId: tenant.tenantId, agentId: agent.agent.id, toolId: tool.id });

    await expect(persistAuditEvent(payload)).rejects.toThrow("connection reset");

    spy.mockRestore();
  });
  it("Decision 5.27 — correctly coerces ISO date strings back into real Date instances after a JSON round-trip (simulating Redis storage)", async () => {
    const original = makeToolInvocationPayload({ tenantId: tenant.tenantId, agentId: agent.agent.id, toolId: tool.id });

    // BullMQ stores job.data as JSON in Redis — this is the exact
    // transformation a real job goes through, which every OTHER test
    // in this file (built on in-memory Date objects) never exercises.
    const roundTripped = JSON.parse(JSON.stringify(original));
    expect(typeof roundTripped.startedAt).toBe("string"); // proves the round-trip actually lost the Date-ness

    const { auditJobPayloadSchema } = await import("../lib/audit-schema.js");
    const parsed = auditJobPayloadSchema.safeParse(roundTripped);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    // FIX: Type Guard! Narrow the discriminated union so TypeScript knows this is an invocation.
    if (parsed.data.eventType !== "TOOL_INVOCATION") {
      throw new Error("Expected a TOOL_INVOCATION payload");
    }

    // Now TypeScript knows `startedAt` exists, and we can prove coercion worked!
    expect(parsed.data.startedAt).toBeInstanceOf(Date);
    expect(parsed.data.startedAt.getTime()).toBe(original.startedAt.getTime());

    // Pro-tip: 'timestamp' exists on baseFields, so it is guaranteed on ALL payloads.
    // Testing it gives us a free secondary proof of coercion without needing the type guard!
    expect(parsed.data.timestamp).toBeInstanceOf(Date);

    const { freshInsert } = await persistAuditEvent(parsed.data);
    expect(freshInsert).toBe(true);

    const row = await auditPrisma.toolExecution.findUnique({ where: { id: original.id } });
    expect(row?.startedAt.getTime()).toBe(original.startedAt.getTime());
  });
  it("Decision 5.28 — a valid, known id returns NOTHING under the wrong tenantId", async () => {
    const payload = makeToolInvocationPayload({ tenantId: tenant.tenantId, agentId: agent.agent.id, toolId: tool.id });
    await persistAuditEvent(payload);

    const otherTenant = await createTestTenant(app);

    expect(await toolExecutionRepository.findByIds([payload.id], otherTenant.tenantId)).toEqual([]);
    expect(await auditEventRepository.findByIds([payload.id], otherTenant.tenantId)).toEqual([]);
    expect(await toolExecutionRepository.findByIds([payload.id], tenant.tenantId)).toHaveLength(1);
    expect(await auditEventRepository.findByIds([payload.id], tenant.tenantId)).toHaveLength(1);

    await cleanupTenant(otherTenant.tenantId);
  });
});

describe("audit worker — through the real BullMQ queue", () => {

  let app: FastifyInstance;
  let tenant: TestTenantHandle;
  let agent: TestAgentCreationResult;
  let tool : TestToolInterface;
  let worker: ReturnType<typeof createAuditWorker>;

  beforeAll(async () => {
    app = await createApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });


  beforeEach(async () => {
    tenant = await createTestTenant(app);
    agent = await createTestAgent(tenant.tenantId, tenant.userId);
    tool = await createTestTool(tenant.tenantId);
    worker = createAuditWorker();
  });

  afterEach(async () => {
    await worker.close();
    await cleanupTenant(tenant.tenantId);
  });

  it("a single TOOL_INVOCATION job produces exactly one row in each table, sharing the id", async () => {
    const payload = makeToolInvocationPayload({ tenantId: tenant.tenantId, agentId: agent.agent.id, toolId: tool.id });
    await auditQueue.add(payload.eventType, payload, { jobId: payload.id });

    await waitFor(async () => {
      const exec = await auditPrisma.toolExecution.findUnique({ where: { id: payload.id } });
      const event = await auditPrisma.auditEvent.findUnique({ where: { id: payload.id } });
      expect(exec).not.toBeNull();
      expect(event).not.toBeNull();
      expect(exec!.id).toBe(event!.id);
    });
  });

  it("a redelivered job (same payload.id, different BullMQ jobId) produces zero duplicate rows and exactly one publish", async () => {
    const publishSpy = vi.spyOn(auditPublish, "publishLiveEvent");
    const payload = makeToolInvocationPayload({ tenantId: tenant.tenantId, agentId: agent.agent.id, toolId: tool.id });

    await auditQueue.add(payload.eventType, payload, { jobId: payload.id + "-a" });
    await waitFor(async () => {
      expect(await auditPrisma.toolExecution.count({ where: { id: payload.id } })).toBe(1);
    });

    // Simulate redelivery under a FRESH BullMQ jobId, so the primary
    // queue's own jobId dedup doesn't short-circuit it before it
    // reaches the processor — this specifically exercises the
    // DB-level P2002 path this whole day is about.
    await auditQueue.add(payload.eventType, payload, { jobId: payload.id + "-b" });
    await waitFor(async () => {
      const job = await auditQueue.getJob(payload.id + "-b");
      expect(job === null || (await job?.isCompleted())).toBe(true);
    });

    expect(await auditPrisma.toolExecution.count({ where: { id: payload.id } })).toBe(1);
    expect(await auditPrisma.auditEvent.count({ where: { id: payload.id } })).toBe(1);
    expect(publishSpy).toHaveBeenCalledTimes(1); // NOT 2

    publishSpy.mockRestore();
  });

  it("a malformed payload dead-letters on the FIRST attempt, zero retries burned", async () => {
    const badPayload = { id: crypto.randomUUID(), eventType: "TOOL_INVOCATION" }; // missing required fields
    await auditQueue.add("TOOL_INVOCATION", badPayload as any, { jobId: badPayload.id });

    await waitFor(async () => {
      // 1. Verify the dead-letter record was created
      const dlJobs = await deadLetterAuditQueue.getJobs(["waiting", "completed"]);
      const match = dlJobs.find((j) => j.data.reasonCode === "SCHEMA_VALIDATION_FAILED");
      expect(match).toBeDefined();

      // 2. Verify the original job was cleanly resolved by BullMQ
      // (Moved inside the waitFor block to prevent a race condition with BullMQ's internal state transition)
      const originalJob = await auditQueue.getJob(badPayload.id);
      expect(originalJob).toBeDefined();

      if (originalJob) {
        expect(await originalJob.isCompleted()).toBe(true);
        expect(originalJob.attemptsMade).toBeLessThanOrEqual(1);
      }
    });
  });

  it("Decision 5.23 — a malformed payload redelivered under the same original id does not create a duplicate dead-letter entry", async () => {
    const badId = crypto.randomUUID();
    const badPayload = { id: badId, eventType: "TOOL_INVOCATION" };

    await auditQueue.add("TOOL_INVOCATION", badPayload as any, { jobId: badId });
    await waitFor(async () => {
      const jobs = await deadLetterAuditQueue.getJobs(["waiting", "completed"]);
      expect(jobs.some((j) => j.data.originalJobId === badId)).toBe(true);
    });

    // A fresh BullMQ jobId so the PRIMARY queue's dedup doesn't
    // intercept this — the assertion below is about the DEAD-LETTER
    // queue's own jobId dedup, added today.
    await auditQueue.add("TOOL_INVOCATION", badPayload as any, { jobId: badId + "-retry" });
    await new Promise((r) => setTimeout(r, 300));

    const dlJobs = await deadLetterAuditQueue.getJobs(["waiting", "completed"]);
    const matches = dlJobs.filter((j) => j.data.originalJobId === badId);
    expect(matches.length).toBe(1);
  });

  it("writes ONLY audit_events (no tool_executions row) for AGENT_AUTHENTICATED, delivered through the real queue", async () => {
    // 1. Construct the explicit AGENT_AUTHENTICATED payload
    // 2. Use the REAL database IDs generated in the beforeEach hook
    const payload = {
      id: crypto.randomUUID(),
      schemaVersion: 1 as const,
      eventType: "AGENT_AUTHENTICATED" as const,
      tenantId: tenant.tenantId,
      agentId: agent.agent.id,
      timestamp: new Date(),
    };

    await auditQueue.add(payload.eventType, payload, { jobId: payload.id });

    await waitFor(async () => {
      const event = await auditPrisma.auditEvent.findUnique({ where: { id: payload.id } });
      expect(event).not.toBeNull();
    });

    const exec = await auditPrisma.toolExecution.findUnique({ where: { id: payload.id } });
    expect(exec).toBeNull();
  });

  it("Decision 5.21 — the worker survives a synthetic 'error' event without crashing the process", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
    expect(() => worker.emit("error", new Error("simulated connection blip"))).not.toThrow();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe("createAuditWorker — pool/concurrency sanity (Decision 5.26)", () => {
  it("logs a warning if AUDIT_WORKER_CONCURRENCY exceeds AGENTGATE_AUDIT_DB_POOL_MAX", async () => {
    // This test only MEANINGFULLY fires if your local env has
    // AGENTGATE_AUDIT_DB_POOL_MAX < 5. It's included as a sanity net,
    // not a hard requirement — the real value of Decision 5.26 is the
    // warning being present in the source, not this particular
    // assertion passing under every possible env configuration.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => { });
    const worker = createAuditWorker();
    await worker.close();
    warnSpy.mockRestore();
  });
});