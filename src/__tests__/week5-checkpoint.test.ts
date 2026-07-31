import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import crypto from "node:crypto";
import Redis from "ioredis";
import { createApp } from "../app.js";
import { redis } from "../lib/redis.js";
import { prisma } from "../lib/prisma.js";
import { auditPrisma } from "../lib/audit-prisma.js";
import { auditQueue, deadLetterAuditQueue } from "../queue/audit.queue.js";
import { createAuditWorker, persistAuditEvent } from "../workers/audit.worker.js";
import { toolExecutionRepository } from "../repositories/tool-execution.repository.js";
import { auditEventRepository } from "../repositories/audit-event.repository.js";
import { listAuditEvents } from "../repositories/audit-event-read.repository.js";
import { capturePreview, AUDIT_PREVIEW_MAX_BYTES } from "../lib/audit-preview.js";
import * as auditPublish from "../lib/audit-publish.js";
import { getAuditHealth } from "../lib/audit-health.js";
import type { ToolInvocationJobPayload } from "../lib/audit-schema.js";
import {
  createTestTenant,
  createTestAgent,
  createTestTool,
  cleanupTenant,
} from "./helpers/test-tenant.factory.js";

// ── shared helpers ──────────────────────────────────────────────────────

async function waitFor(assertion: () => Promise<void>, timeoutMs = 8000, intervalMs = 100): Promise<void> {
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

function makeInvocationPayload(overrides: Partial<ToolInvocationJobPayload> = {}): ToolInvocationJobPayload {
  const now = new Date();
  return {
    id: crypto.randomUUID(),
    schemaVersion: 1,
    eventType: "TOOL_INVOCATION",
    tenantId: "tenant-placeholder",
    agentId: "agent-placeholder",
    toolId: "tool-placeholder",
    status: "success",
    durationMs: 10,
    startedAt: now,
    completedAt: now,
    timestamp: now,
    inputTruncated: false,
    outputTruncated: false,
    ...overrides,
  };
}

/** Decision 5.62 — close worker(s) FIRST, obliterate queues SECOND,
 * Postgres cleanup LAST. Wrong order risks an obliterate() failure or a
 * dangling worker processing a job whose backing data just vanished. */
async function teardownGate(opts: { workers?: any[]; tenantIds?: string[] }): Promise<void> {
  for (const w of opts.workers ?? []) {
    try {
      await w.close();
    } catch {
      /* best-effort — see Gate 2's note on not trusting close() twice */
    }
  }
  await auditQueue.obliterate({ force: true }).catch(() => { });
  await deadLetterAuditQueue.obliterate({ force: true }).catch(() => { });
  for (const t of opts.tenantIds ?? []) {
    await cleanupTenant(t).catch(() => { });
  }
}

let app: Awaited<ReturnType<typeof createApp>>;

beforeAll(async () => {
  app = await createApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────
// GATE 1 — 100-burst durability
// ─────────────────────────────────────────────────────────────────────
describe("GATE 1 — 100-burst durability", () => {
  it("all 100 concurrently-enqueued events land in BOTH tables within budget", async () => {
    const tenant = await createTestTenant(app);
    const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
    const tool = await createTestTool(tenant.tenantId);
    const worker = createAuditWorker();

    const ids = Array.from({ length: 100 }, () => crypto.randomUUID());
    await Promise.all(
      ids.map((id) => {
        const payload = makeInvocationPayload({ id, tenantId: tenant.tenantId, agentId: agent.id, toolId: tool.id });
        return auditQueue.add(payload.eventType, payload, { jobId: id });
      })
    );

    await waitFor(async () => {
      expect(await auditPrisma.toolExecution.count({ where: { id: { in: ids } } })).toBe(100);
      expect(await auditPrisma.auditEvent.count({ where: { id: { in: ids } } })).toBe(100);
    }, 25_000);

    await teardownGate({ workers: [worker], tenantIds: [tenant.tenantId] });
  }, 30_000);
});

// ─────────────────────────────────────────────────────────────────────
// GATE 2 — crash recovery via REAL lock-expiration, not close()
// ─────────────────────────────────────────────────────────────────────
describe("GATE 2 — crash recovery (real stalled-lock detection)", () => {
  it("a job locked by a worker that vanishes mid-transaction is picked up by a fresh worker", async () => {
    const tenant = await createTestTenant(app);
    const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
    const tool = await createTestTool(tenant.tenantId);

    const slowPayload = makeInvocationPayload({ tenantId: tenant.tenantId, agentId: agent.id, toolId: tool.id });

    const realCreate = toolExecutionRepository.create.bind(toolExecutionRepository);

    // FIX: Cast the mock implementation callback to bypass Prisma's fluent API signature strictness
    const createSpy = vi.spyOn(toolExecutionRepository, "create").mockImplementation((async (data: any, tx: any) => {
      if (data.id === slowPayload.id) {
        await new Promise((r) => setTimeout(r, 4000));
      }
      return realCreate(data, tx);
    }) as any);

    // A dedicated, DISCONNECTABLE connection — .duplicate() clones ioredis's
    // connection options without needing to know the raw connection string.
    const crashConnection = redis.duplicate();
    const crashingWorker = createAuditWorker({
      connection: crashConnection,
      lockDuration: 1000,
      stalledInterval: 500,
    });

    await auditQueue.add(slowPayload.eventType, slowPayload, { jobId: slowPayload.id });

    // Deterministic, not a sleep-and-hope: poll until the queue itself
    // reports the job active.
    await waitFor(async () => {
      expect(await auditQueue.getActiveCount()).toBeGreaterThanOrEqual(1);
    }, 5000, 25);

    // Simulate a real process death — abrupt, not graceful. From Redis's
    // perspective this is indistinguishable from the worker's host
    // getting OOM-killed. Deliberately NOT calling crashingWorker.close().
    crashConnection.disconnect();

    // A fresh worker, own connection, same short timings so its OWN
    // stalled-job check interval fires within this test's budget.
    const freshWorker = createAuditWorker({ lockDuration: 1000, stalledInterval: 500 });

    await waitFor(async () => {
      const row = await auditPrisma.toolExecution.findUnique({ where: { id: slowPayload.id } });
      expect(row).not.toBeNull();
    }, 15_000);

    expect(await auditPrisma.toolExecution.count({ where: { id: slowPayload.id } })).toBe(1);
    expect(await auditPrisma.auditEvent.count({ where: { id: slowPayload.id } })).toBe(1);

    createSpy.mockRestore();
    await crashConnection.quit().catch(() => { });
    // crashingWorker's own connection is already dead — don't call
    // .close() against it; let it fall out of scope. See F4's note on
    // not trusting undocumented double-close() semantics.
    await teardownGate({ workers: [freshWorker], tenantIds: [tenant.tenantId] });
  }, 25_000);
});

// ─────────────────────────────────────────────────────────────────────
// GATE 3 — tenant isolation
// ─────────────────────────────────────────────────────────────────────
describe("GATE 3 — tenant isolation", () => {
  it("Tenant A's event never appears under Tenant B's tenantId, even for a valid known id", async () => {
    const tenantA = await createTestTenant(app);
    const tenantB = await createTestTenant(app);
    const { agent } = await createTestAgent(tenantA.tenantId, tenantA.userId);
    const tool = await createTestTool(tenantA.tenantId);
    const worker = createAuditWorker();

    const payload = makeInvocationPayload({ tenantId: tenantA.tenantId, agentId: agent.id, toolId: tool.id });
    await auditQueue.add(payload.eventType, payload, { jobId: payload.id });

    await waitFor(async () => {
      expect(await auditPrisma.auditEvent.findUnique({ where: { id: payload.id } })).not.toBeNull();
    });

    // Same id, wrong tenant — belt-and-suspenders filter (Decision 5.13)
    const crossTenantLookup = await auditPrisma.auditEvent.findFirst({
      where: { id: payload.id, tenantId: tenantB.tenantId },
    });
    expect(crossTenantLookup).toBeNull();

    const listForA = await listAuditEvents(tenantA.tenantId, { limit: 25 });
    const listForB = await listAuditEvents(tenantB.tenantId, { limit: 25 });
    expect(listForA.data.some((r) => r.id === payload.id)).toBe(true);
    expect(listForB.data.some((r) => r.id === payload.id)).toBe(false);

    await teardownGate({ workers: [worker], tenantIds: [tenantA.tenantId, tenantB.tenantId] });
  });
});

// ─────────────────────────────────────────────────────────────────────
// GATE 4 — duplicate delivery: zero duplicate rows, zero duplicate publishes
// ─────────────────────────────────────────────────────────────────────
describe("GATE 4 — duplicate delivery is fully idempotent", () => {
  it("a redelivered job produces no duplicate rows and publishes exactly once", async () => {
    const tenant = await createTestTenant(app);
    const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
    const tool = await createTestTool(tenant.tenantId);
    const worker = createAuditWorker();
    const publishSpy = vi.spyOn(auditPublish, "publishLiveEvent");

    const payload = makeInvocationPayload({ tenantId: tenant.tenantId, agentId: agent.id, toolId: tool.id });

    await auditQueue.add(payload.eventType, payload, { jobId: payload.id + "-a" });
    await waitFor(async () => {
      expect(await auditPrisma.toolExecution.count({ where: { id: payload.id } })).toBe(1);
    });

    // Fresh BullMQ jobId so the QUEUE's own dedup doesn't short-circuit
    // this — we want to hit the DB-level P2002 path specifically.
    await auditQueue.add(payload.eventType, payload, { jobId: payload.id + "-b" });
    await waitFor(async () => {
      const job = await auditQueue.getJob(payload.id + "-b");
      expect(job === null || (await job?.isCompleted())).toBe(true);
    });

    expect(await auditPrisma.toolExecution.count({ where: { id: payload.id } })).toBe(1);
    expect(await auditPrisma.auditEvent.count({ where: { id: payload.id } })).toBe(1);
    expect(publishSpy).toHaveBeenCalledTimes(1);

    await teardownGate({ workers: [worker], tenantIds: [tenant.tenantId] });
  });
});

// ─────────────────────────────────────────────────────────────────────
// GATE 5 — malformed payload dead-letters immediately, zero retries burned
// ─────────────────────────────────────────────────────────────────────
describe("GATE 5 — deterministic schema failures never retry", () => {
  it("a payload missing required fields dead-letters on the first attempt", async () => {
    const worker = createAuditWorker();
    const badId = crypto.randomUUID();

    await auditQueue.add("TOOL_INVOCATION", { id: badId, eventType: "TOOL_INVOCATION" } as any, { jobId: badId });

    await waitFor(async () => {
      const dl = await deadLetterAuditQueue.getJobs(["waiting", "completed"]);
      expect(
        dl.some((j) => j.data.originalJobId === badId && j.data.reasonCode === "SCHEMA_VALIDATION_FAILED")
      ).toBe(true);
    });

    const originalJob = await auditQueue.getJob(badId);
    if (originalJob) {
      expect(await originalJob.isCompleted()).toBe(true);
      expect(originalJob.attemptsMade).toBeLessThanOrEqual(1);
    }

    await teardownGate({ workers: [worker] });
  });

  it("Decision 5.64 — an unrecognized schemaVersion is rejected identically to any other schema violation", async () => {
    const worker = createAuditWorker();
    const badId = crypto.randomUUID();
    const payload = makeInvocationPayload({ id: badId, tenantId: "t", agentId: "a", toolId: "tl" });

    await auditQueue.add("TOOL_INVOCATION", { ...payload, schemaVersion: 2 } as any, { jobId: badId });

    await waitFor(async () => {
      const dl = await deadLetterAuditQueue.getJobs(["waiting", "completed"]);
      expect(dl.some((j) => j.data.originalJobId === badId)).toBe(true);
    });

    expect(await auditPrisma.auditEvent.findUnique({ where: { id: badId } })).toBeNull();
    await teardownGate({ workers: [worker] });
  });
});

// ─────────────────────────────────────────────────────────────────────
// GATE 6 — genuine infra failure exhausts real backoff → dead-letter
// ─────────────────────────────────────────────────────────────────────
describe("GATE 6 — infra failures exhaust real BullMQ retries before dead-lettering", () => {
  it("a persistently-failing write retries 3 times with backoff, then lands as INFRA_FAILURE_EXHAUSTED", async () => {
    const failId = crypto.randomUUID();

    // FIX: Cast the mock implementation callback
    const createSpy = vi.spyOn(toolExecutionRepository, "create").mockImplementation((async (data: any) => {
      if (data.id === failId) {
        throw new Error("simulated infra failure — not P2002");
      }
      throw new Error("unexpected id in this isolated gate");
    }) as any);

    // Fast test-only backoff — proves the REAL attempts/backoff/dead-letter
    // pipeline without a 36-second test (Decision 5.55).
    const worker = createAuditWorker({ backoffMs: [50, 100, 150] });

    const payload = makeInvocationPayload({ id: failId, tenantId: "t", agentId: "a", toolId: "tl" });
    await auditQueue.add(payload.eventType, payload, { jobId: failId, attempts: 3 });

    await waitFor(async () => {
      const dl = await deadLetterAuditQueue.getJobs(["waiting", "completed"]);
      expect(
        dl.some((j) => j.data.originalJobId === failId && j.data.reasonCode === "INFRA_FAILURE_EXHAUSTED")
      ).toBe(true);
    }, 6000);

    const originalJob = await auditQueue.getJob(failId);
    if (originalJob) {
      expect(originalJob.attemptsMade).toBe(3);
    }
    expect(await auditPrisma.toolExecution.findUnique({ where: { id: failId } })).toBeNull();

    createSpy.mockRestore();
    await teardownGate({ workers: [worker] });
  }, 10_000);
});

// ─────────────────────────────────────────────────────────────────────
// GATE 7 — secret-shaped input redacted end-to-end, queryable via the
// REAL GET /audit-events route (Decision 5.56)
//
// NOTE: implemented at capturePreview() — the real, patched function —
// rather than through executeTool(), which I don't have visibility into.
// This still proves the F1 regression fix AND the write->read wiring
// together. Once execute-tool.ts is shared, the same assertions belong
// wrapped around a real executeTool() call per the original gate design.
// ─────────────────────────────────────────────────────────────────────
describe("GATE 7 — secret redaction survives the full write+read pipeline", () => {
  it("an apiKey/password-shaped input is never queryable in raw form via the real read API", async () => {
    const tenant = await createTestTenant(app);
    const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
    const tool = await createTestTool(tenant.tenantId);
    const worker = createAuditWorker();

    const rawSecretInput = {
      apiKey: "sk_live_supersecret_12345",
      user: { password: "hunter2-hunter2" },
      connectionString: "postgres://svc:S3cret@host:5432/db",
      note: "harmless field, unredacted",
    };

    const inputCap = capturePreview(rawSecretInput);
    expect(inputCap.truncated).toBe(false);

    const payload = makeInvocationPayload({
      tenantId: tenant.tenantId,
      agentId: agent.id,
      toolId: tool.id,
      inputPreview: inputCap.preview,
    });
    await auditQueue.add(payload.eventType, payload, { jobId: payload.id });

    await waitFor(async () => {
      expect(await auditPrisma.toolExecution.findUnique({ where: { id: payload.id } })).not.toBeNull();
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/audit-events/${payload.id}`,
      headers: { Authorization: `Bearer ${tenant.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    const rawText = JSON.stringify(body.inputPreview);
    expect(rawText).not.toContain("sk_live_supersecret_12345");
    expect(rawText).not.toContain("hunter2-hunter2");
    expect(rawText).not.toContain("S3cret");
    expect(rawText).toContain("[REDACTED]");
    expect(body.inputPreview.note).toBe("harmless field, unredacted"); // non-sensitive data survives

    await teardownGate({ workers: [worker], tenantIds: [tenant.tenantId] });
  });
});

// ─────────────────────────────────────────────────────────────────────
// GATE 8 — read-API reconstruction over a collision-prone burst
// ─────────────────────────────────────────────────────────────────────
describe("GATE 8 — keyset pagination is exhaustive and gap/duplicate-free", () => {
  it("a 60-item burst pages cleanly via the repository (rate-limit-free), and via a small number of real HTTP calls", async () => {
    const tenant = await createTestTenant(app);
    const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
    const tool = await createTestTool(tenant.tenantId);
    const worker = createAuditWorker();

    const ids = Array.from({ length: 60 }, () => crypto.randomUUID());
    await Promise.all(
      ids.map((id) => {
        const payload = makeInvocationPayload({ id, tenantId: tenant.tenantId, agentId: agent.id, toolId: tool.id });
        return auditQueue.add(payload.eventType, payload, { jobId: id });
      })
    );
    await waitFor(async () => {
      expect(await auditPrisma.toolExecution.count({ where: { id: { in: ids } } })).toBe(60);
    }, 15_000);

    // Exhaustive walk directly against the repository — no HTTP, no rate
    // limit involved. This is where the real pagination-correctness proof
    // lives (Decision 5.57 refinement — avoids tripping Day 5's
    // checkRateLimitByKey budget).
    const seen = new Set<string>();
    let cursor: { createdAt: number; id: string } | undefined;
    for (let i = 0; i < 20 && seen.size < 60; i++) {
      const page = await listAuditEvents(tenant.tenantId, { limit: 5 }, cursor as any);
      for (const row of page.data) seen.add(row.id);
      if (!page.nextCursor) break;
      cursor = JSON.parse(Buffer.from(page.nextCursor, "base64url").toString("utf-8"));
    }
    expect(seen.size).toBe(60);

    // A handful of real HTTP calls at the max page size — proves auth,
    // tenant scoping, and the route itself, without stressing the
    // rate limiter.
    const res = await app.inject({
      method: "GET",
      url: "/api/audit-events?limit=50",
      headers: { Authorization: `Bearer ${tenant.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.length).toBe(50);
    expect(body.nextCursor).toBeDefined();

    await teardownGate({ workers: [worker], tenantIds: [tenant.tenantId] });
  }, 20_000);
});

// ─────────────────────────────────────────────────────────────────────
// GATE 9 — health/dead-letter integration, advisory-only, proven live
// ─────────────────────────────────────────────────────────────────────
describe("GATE 9 — dead-letter presence is advisory, never fatal to /health", () => {
  it("a real dead-lettered job flips getAuditHealth() while GET /health stays 200", async () => {
    const worker = createAuditWorker();
    const badId = crypto.randomUUID();
    await auditQueue.add("TOOL_INVOCATION", { id: badId, eventType: "TOOL_INVOCATION" } as any, { jobId: badId });

    await waitFor(async () => {
      const dl = await deadLetterAuditQueue.getJobs(["waiting", "completed"]);
      expect(dl.some((j) => j.data.originalJobId === badId)).toBe(true);
    });

    const health = await getAuditHealth();
    expect(health.healthy).toBe(false);
    expect(health.deadLetterCount).toBeGreaterThan(0);

    const res = await app.inject({ method: "GET", url: "/healthcheck" });
    expect(res.statusCode).toBe(200); // Decision 5.36/5.66 — advisory only, never fatal

    await teardownGate({ workers: [worker] });
  });
});

// ─────────────────────────────────────────────────────────────────────
// GATE 10 — pub/sub correctness, subscription-first, small controlled batch
// (Decision 5.59 — NOT an exact-count assertion under load; pub/sub is
// documented best-effort)
// ─────────────────────────────────────────────────────────────────────
describe("GATE 10 — pub/sub fan-out is correct on a controlled batch", () => {
  it("a subscriber established BEFORE publish receives the right channel, right shape, no cross-tenant leak", async () => {
    const tenant = await createTestTenant(app);
    const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
    const tool = await createTestTool(tenant.tenantId);
    const worker = createAuditWorker();

    const subClient = redis.duplicate();
    const received: string[] = [];
    await subClient.subscribe(`events:tenant:${tenant.tenantId}`);
    subClient.on("message", (_channel, message) => received.push(message));

    // Give the subscription a moment to actually establish before publish.
    await new Promise((r) => setTimeout(r, 200));

    const payload = makeInvocationPayload({ tenantId: tenant.tenantId, agentId: agent.id, toolId: tool.id });
    await auditQueue.add(payload.eventType, payload, { jobId: payload.id });

    await waitFor(async () => {
      expect(received.length).toBeGreaterThanOrEqual(1);
    }, 5000);

    const parsed = JSON.parse(received[0]!);
    expect(parsed.id).toBe(payload.id);
    expect(parsed.tenantId).toBe(tenant.tenantId);
    expect(parsed).not.toHaveProperty("inputPreview"); // slim event, no preview leak

    await subClient.unsubscribe();
    await subClient.quit();
    await teardownGate({ workers: [worker], tenantIds: [tenant.tenantId] });
  });
});

// ─────────────────────────────────────────────────────────────────────
// GATE 11 — non-serializable input never crashes capture (Decision 5.60)
// ─────────────────────────────────────────────────────────────────────
describe("GATE 11 — non-serializable values are handled safely", () => {
  it("a self-referential (circular) object does not throw", () => {
    const circular: Record<string, unknown> = { name: "loop" };
    circular.self = circular;

    expect(() => capturePreview(circular)).not.toThrow();
    const result = capturePreview(circular);
    expect(() => JSON.stringify(result.preview)).not.toThrow();
  });

  it("a BigInt leaf value does not throw", () => {
    expect(() => capturePreview({ bigNumber: BigInt(9007199254740993) })).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────
// GATE 12 — oversized real input capped end-to-end (Decision 5.61)
// ─────────────────────────────────────────────────────────────────────
describe("GATE 12 — oversized input is capped through the real pipeline", () => {
  it("a >8KB input transits capture -> queue -> worker -> Postgres and lands truncated", async () => {
    const tenant = await createTestTenant(app);
    const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
    const tool = await createTestTool(tenant.tenantId);
    const worker = createAuditWorker();

    const huge = { blob: "x".repeat(AUDIT_PREVIEW_MAX_BYTES * 3) };
    const inputCap = capturePreview(huge);
    expect(inputCap.truncated).toBe(true);

    const payload = makeInvocationPayload({
      tenantId: tenant.tenantId,
      agentId: agent.id,
      toolId: tool.id,
      inputPreview: inputCap.preview,
      inputTruncated: true,
    });
    await auditQueue.add(payload.eventType, payload, { jobId: payload.id });

    await waitFor(async () => {
      const row = await auditPrisma.toolExecution.findUnique({ where: { id: payload.id } });
      expect(row).not.toBeNull();
      expect(row!.inputTruncated).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(row!.inputPreview), "utf-8")).toBeLessThan(
        AUDIT_PREVIEW_MAX_BYTES + 200
      );
    });

    await teardownGate({ workers: [worker], tenantIds: [tenant.tenantId] });
  });
});

// ─────────────────────────────────────────────────────────────────────
// GATE 13 — stub event types (PERMISSION_DENIED / RATE_LIMITED) process
// correctly today, forward-compat for Week 6 (Decision 5.63)
// ─────────────────────────────────────────────────────────────────────
describe("GATE 13 — stub invocation-shaped events already work end-to-end", () => {
  it("PERMISSION_DENIED writes both tables like TOOL_INVOCATION does", async () => {
    const tenant = await createTestTenant(app);
    const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
    const tool = await createTestTool(tenant.tenantId);

    const id = crypto.randomUUID();
    const now = new Date();
    const { freshInsert } = await persistAuditEvent({
      id,
      schemaVersion: 1,
      eventType: "PERMISSION_DENIED",
      tenantId: tenant.tenantId,
      agentId: agent.id,
      toolId: tool.id,
      status: "denied",
      denialReason: "agent_not_permitted",
      durationMs: 1,
      startedAt: now,
      completedAt: now,
      timestamp: now,
      inputTruncated: false,
      outputTruncated: false,
    } as any);

    expect(freshInsert).toBe(true);
    expect(await auditPrisma.toolExecution.findUnique({ where: { id } })).not.toBeNull();
    expect(await auditPrisma.auditEvent.findUnique({ where: { id } })).not.toBeNull();

    await teardownGate({ tenantIds: [tenant.tenantId] });
  });

  it("RATE_LIMITED writes both tables like TOOL_INVOCATION does", async () => {
    const tenant = await createTestTenant(app);
    const { agent } = await createTestAgent(tenant.tenantId, tenant.userId);
    const tool = await createTestTool(tenant.tenantId);

    const id = crypto.randomUUID();
    const now = new Date();
    const { freshInsert } = await persistAuditEvent({
      id,
      schemaVersion: 1,
      eventType: "RATE_LIMITED",
      tenantId: tenant.tenantId,
      agentId: agent.id,
      toolId: tool.id,
      status: "rate_limited",
      durationMs: 1,
      startedAt: now,
      completedAt: now,
      timestamp: now,
      inputTruncated: false,
      outputTruncated: false,
    } as any);

    expect(freshInsert).toBe(true);
    expect(await auditPrisma.toolExecution.findUnique({ where: { id } })).not.toBeNull();

    await teardownGate({ tenantIds: [tenant.tenantId] });
  });
});