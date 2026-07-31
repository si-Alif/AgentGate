import { Worker } from "bullmq";
import type { Job } from "bullmq";
import { redis } from "../lib/redis.js";
import { auditPrisma } from "../lib/audit-prisma.js";
import { env } from "../config/env.js";
import { auditJobPayloadSchema, isInvocationShapedEvent } from "../lib/audit-schema.js";
import type { AuditJobPayload } from "../lib/audit-schema.js";
import { AUDIT_QUEUE_NAME, deadLetterAuditQueue } from "../queue/audit.queue.js";
import type { DeadLetterJobData, DeadLetterReasonCode } from "../queue/audit.queue.js";
import { toolExecutionRepository } from "../repositories/tool-execution.repository.js";
import { auditEventRepository } from "../repositories/audit-event.repository.js";
import { publishLiveEvent } from "../lib/audit-publish.js";
import { registerAuditWorkerForHealth } from "../lib/audit-health.js";

export const AUDIT_WORKER_CONCURRENCY = 5;

const AUDIT_TRANSACTION_TIMEOUT_MS = 10_000;
const AUDIT_TRANSACTION_MAX_WAIT_MS = 5_000;

/** 1s, 5s, 30s — matches HLD/roadmap.md's stated backoff shape exactly. */
const AUDIT_BACKOFF_MS = [1_000, 5_000, 30_000] as const;

// ── persistAuditEvent, writeDeadLetter, processJob: UNCHANGED ──────────
// (identical to your existing file — omitted here only to keep this
// patch focused; do not remove them from the real file)

export async function persistAuditEvent(payload: AuditJobPayload): Promise<{ freshInsert: boolean }> {
  try {
    await auditPrisma.$transaction(
      async (tx) => {
        if (isInvocationShapedEvent(payload)) {
          await toolExecutionRepository.create(
            {
              id: payload.id,
              tenantId: payload.tenantId,
              agentId: payload.agentId,
              toolId: payload.toolId,
              status: payload.status,
              durationMs: payload.durationMs,
              startedAt: payload.startedAt,
              completedAt: payload.completedAt,
              inputTruncated: payload.inputTruncated,
              outputTruncated: payload.outputTruncated,
              inputPreview: payload.inputPreview,
              outputPreview: payload.outputPreview,
              errorCode: payload.errorCode,
              errorMessage: payload.errorMessage,
            },
            tx
          );
        }

        await auditEventRepository.create(
          {
            id: payload.id,
            tenantId: payload.tenantId,
            agentId: "agentId" in payload ? payload.agentId : null,
            userId: null,
            toolId: "toolId" in payload ? payload.toolId : null,
            eventType: payload.eventType,
            status: isInvocationShapedEvent(payload) ? payload.status : null,
            payload,
          },
          tx
        );
      },
      { timeout: AUDIT_TRANSACTION_TIMEOUT_MS, maxWait: AUDIT_TRANSACTION_MAX_WAIT_MS }
    );
    return { freshInsert: true };
  } catch (err: any) {
    if (err?.code === "P2002") {
      return { freshInsert: false };
    }
    throw err;
  }
}

async function writeDeadLetter(
  reasonCode: DeadLetterReasonCode,
  detail: unknown,
  originalJobId: string,
  rawData: unknown
): Promise<void> {
  const data: DeadLetterJobData = { reasonCode, detail, originalJobId, rawData };
  try {
    await deadLetterAuditQueue.add("dead-letter", data, { jobId: originalJobId });
  } catch (err) {
    console.error(
      `[audit-worker] failed to write dead-letter record for job ${originalJobId} ` +
      `(reason=${reasonCode}) — this diagnostic record is lost, not retried:`,
      err
    );
  }
}

export async function processJob(job: Job): Promise<void> {
  const parsed = auditJobPayloadSchema.safeParse(job.data);

  if (!parsed.success) {
    await writeDeadLetter("SCHEMA_VALIDATION_FAILED", parsed.error.flatten(), job.id ?? "unknown", job.data);
    return;
  }

  const payload = parsed.data;
  const { freshInsert } = await persistAuditEvent(payload);

  if (freshInsert) {
    await publishLiveEvent(payload);
  }
}

// ── createAuditWorker: THE ACTUAL CHANGE ────────────────────────────────

/**
 * Decision 5.53 — a pure testability seam, all fields optional, every
 * default identical to today's production behavior. Mirrors Week 4's
 * dispatcher/resolver injection precedent: production code never passes
 * an override; only tests do.
 *
 *  - connection     — inject a DEDICATED, disconnectable Redis client so
 *                      a test can simulate a real process crash
 *                      (abrupt `.disconnect()`) rather than a graceful
 *                      `.close()`, which exercises a different code path
 *                      (see Decision 5.54 / Finding F3).
 *  - lockDuration /
 *    stalledInterval — shrink so BullMQ's real stalled-job detector
 *                      fires within a test's timeout budget instead of
 *                      the production 30s default.
 *  - backoffMs       — swap the real [1s,5s,30s] schedule for something
 *                      like [50,100,150] so a genuine-infra-failure ->
 *                      3-attempts -> dead-letter test runs in
 *                      milliseconds instead of 36 seconds (Decision 5.55).
 */
export interface AuditWorkerOverrides {
  connection?: typeof redis;
  lockDuration?: number;
  stalledInterval?: number;
  backoffMs?: readonly number[];
}

export function createAuditWorker(overrides: AuditWorkerOverrides = {}): Worker {
  if (AUDIT_WORKER_CONCURRENCY > env.AGENTGATE_AUDIT_DB_POOL_MAX) {
    console.warn(
      `[audit-worker] AUDIT_WORKER_CONCURRENCY (${AUDIT_WORKER_CONCURRENCY}) exceeds ` +
      `AGENTGATE_AUDIT_DB_POOL_MAX (${env.AGENTGATE_AUDIT_DB_POOL_MAX}) — concurrent jobs ` +
      `may queue waiting for a free Postgres connection.`
    );
  }

  const backoffSchedule = overrides.backoffMs ?? AUDIT_BACKOFF_MS;
  const connection = overrides.connection ?? redis;

  const worker = new Worker(AUDIT_QUEUE_NAME, processJob, {
    connection,
    concurrency: AUDIT_WORKER_CONCURRENCY,
    ...(overrides.lockDuration !== undefined ? { lockDuration: overrides.lockDuration } : {}),
    ...(overrides.stalledInterval !== undefined ? { stalledInterval: overrides.stalledInterval } : {}),
    settings: {
      backoffStrategy: (attemptsMade: number) =>
        backoffSchedule[attemptsMade - 1] ?? (backoffSchedule[backoffSchedule.length - 1] as number),
    },
  });

  worker.on("error", (err) => {
    console.error("[audit-worker] worker-level connection error:", err.message);
  });

  worker.on("failed", async (job, err) => {
    console.error(`[audit-worker] job ${job?.id} failed (attempt ${job?.attemptsMade}):`, err.message);
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      await writeDeadLetter("INFRA_FAILURE_EXHAUSTED", err.message, job.id ?? "unknown", job.data);
    }
  });

  registerAuditWorkerForHealth(worker);
  return worker;
}