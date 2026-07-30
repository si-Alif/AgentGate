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

function resolveBackoffMs(attemptsMade: number): number {
  return AUDIT_BACKOFF_MS[attemptsMade - 1] ?? AUDIT_BACKOFF_MS[AUDIT_BACKOFF_MS.length - 1] as number;
}


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
      // Unique-constraint conflict on `id` — this exact event was
      // already durably committed by a prior attempt, sequential or
      // concurrent. At-least-once redelivery is expected BullMQ
      // behavior; this is an idempotent no-op, not a failure.
      return { freshInsert: false };
    }
    throw err; // genuine infra failure — let BullMQ's attempts/backoff apply
  }
}

// writes diagnostic dead letter record without ever letting a failure to do so propagate back into BullMQ's retry machinery
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
    // Deterministic failure — see Decision 5.9. Resolving (not
    // throwing) tells BullMQ this job is DONE, not failed-and-retryable;
    // we record it ourselves, separately, with a distinct reason code.
    await writeDeadLetter("SCHEMA_VALIDATION_FAILED", parsed.error.flatten(), job.id ?? "unknown", job.data);
    return;
  }

  const payload = parsed.data;
  const { freshInsert } = await persistAuditEvent(payload);

  if (freshInsert) {
    // publishLiveEvent already swallows its own errors internally
    // (audit-publish.ts) and never throws — deliberately NOT wrapped
    // again here, since a publish failure must never be allowed to
    // retry a Postgres write that already succeeded.
    await publishLiveEvent(payload);
  }
}

export function createAuditWorker(): Worker {
  if (AUDIT_WORKER_CONCURRENCY > env.AGENTGATE_AUDIT_DB_POOL_MAX) {
    // Not a hard failure — a slower worker is recoverable; a starved
    // pool discovered only at Week 8's 50-agent stress test is not.
    // See Decision 5.26.
    console.warn(
      `[audit-worker] AUDIT_WORKER_CONCURRENCY (${AUDIT_WORKER_CONCURRENCY}) exceeds ` +
      `AGENTGATE_AUDIT_DB_POOL_MAX (${env.AGENTGATE_AUDIT_DB_POOL_MAX}) — concurrent jobs ` +
      `may queue waiting for a free Postgres connection.`
    );
  }

  const worker = new Worker(AUDIT_QUEUE_NAME, processJob, {
    connection: redis,
    concurrency: AUDIT_WORKER_CONCURRENCY,
    settings: {
      backoffStrategy: (attemptsMade: number) => resolveBackoffMs(attemptsMade),
    },
  });

  // Worker is its OWN EventEmitter — separate from auditQueue /
  // deadLetterAuditQueue (already covered by Day 2's amendment) and
  // separate from the underlying redis.ts client (Week 3). Same
  // footgun, a third time, one layer up. See Decision 5.21.
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