import { Worker } from "bullmq";
import type { Job } from "bullmq";
import { redis } from "../lib/redis.js";
import { env } from "../config/env.js";
import { EMAIL_QUEUE_NAME, deadLetterEmailQueue } from "../queue/email.queue.js";
import type { EmailQueueJob, EmailDeadLetterJobData, EmailDeadLetterReasonCode } from "../queue/email.queue.js";
import { getEmailProvider } from "../lib/email/email-provider.factory.js";
import { PermanentEmailError, TransientEmailError } from "../lib/email/email-provider.js";
import { renderVerificationEmail } from "../lib/email/email-templates.js";
import { registerEmailWorkerForHealth } from "../lib/email/email-health.js";

const EMAIL_BACKOFF_MS = [1_000, 5_000, 30_000] as const; // matches audit.worker.ts (Week 5)

function resolveBackoffMs(attemptsMade: number): number {
  const fallback = EMAIL_BACKOFF_MS[EMAIL_BACKOFF_MS.length - 1]!;
  return EMAIL_BACKOFF_MS[attemptsMade - 1] ?? fallback;
}

async function writeDeadLetter(
  reasonCode: EmailDeadLetterReasonCode,
  detail: string,
  originalJobId: string,
  rawData: EmailQueueJob
): Promise<void> {
  const data: EmailDeadLetterJobData = { reasonCode, detail, originalJobId, rawData };
  try {
    await deadLetterEmailQueue.add("dead-letter", data, { jobId: originalJobId });
  } catch (err) {
    // A failed diagnostic write must never change what happens to the
    // original job — mirrors audit.worker.ts's own guarded write.
    console.error(`[email-worker] failed to write dead-letter record for ${originalJobId} (${reasonCode}):`, err);
  }
}

async function processJob(job: Job<EmailQueueJob>): Promise<void> {
  const provider = getEmailProvider();

  // Defensive runtime check, not a TS-reachable branch today — job
  // data crosses a Redis/JSON boundary and doesn't inherit compile-
  // time guarantees . A future second job type, or a stale/
  // legacy payload, lands here rather than crashing the worker.
  if ((job.data.type as string) !== "verification") {
    await writeDeadLetter("UNKNOWN_JOB_TYPE", `Unrecognized email job type: ${job.data.type}`, job.id ?? "unknown", job.data);
    return;
  }

  const rendered = renderVerificationEmail({ token: job.data.token });

  try {
    await provider.send({ to: job.data.email, subject: rendered.subject, html: rendered.html, text: rendered.text });
  } catch (err) {
    if (err instanceof PermanentEmailError) {
      // Dead-letter immediately — zero retries burned on a failure retrying can never fix
      await writeDeadLetter("PERMANENT_PROVIDER_ERROR", err.message, job.id ?? "unknown", job.data);
      return;
    }
    if (err instanceof TransientEmailError) {
      // Rethrow — BullMQ's attempts/backoff (configured on the Queue)
      // drives the retry; the 'failed' listener below dead-letters
      // only once attempts are genuinely exhausted.
      throw err;
    }
    // Unclassified — default to the safer path rather than silently dropping it
    throw new TransientEmailError(`Unclassified provider error: ${(err as Error).message}`, err);
  }
}

export function createEmailWorker(): Worker<EmailQueueJob> {
  const worker = new Worker<EmailQueueJob>(EMAIL_QUEUE_NAME, processJob, {
    connection: redis,
    concurrency: env.AGENTGATE_EMAIL_WORKER_CONCURRENCY,
    settings: {
      backoffStrategy: (attemptsMade: number) => resolveBackoffMs(attemptsMade),
    },
  });

  worker.on("error", (err) => {
    console.error("[email-worker] worker-level connection error:", err.message);
  });

  worker.on("failed", async (job, err) => {
    console.error(`[email-worker] job ${job?.id} failed (attempt ${job?.attemptsMade}):`, err.message);
    // Only TransientEmailError/unclassified errors ever reach here —
    // PermanentEmailError already resolved (not threw) inside
    // processJob, so 'failed' only fires once real retries are spent.
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      await writeDeadLetter("TRANSIENT_FAILURE_EXHAUSTED", err.message, job.id ?? "unknown", job.data);
    }
  });

  registerEmailWorkerForHealth(worker);
  return worker;
}