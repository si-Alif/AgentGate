import { Queue } from "bullmq";
import { redis } from "../lib/redis.js";

export const EMAIL_QUEUE_NAME = "email";
export const DEAD_LETTER_EMAIL_QUEUE_NAME = "dead-letter-email";

export type EmailJobType = "verification";

export interface EmailQueueJob {
  type: EmailJobType;
  email: string;
  token: string;
}

export type EmailDeadLetterReasonCode =
  | "PERMANENT_PROVIDER_ERROR" | "TRANSIENT_FAILURE_EXHAUSTED" | "UNKNOWN_JOB_TYPE";

export interface EmailDeadLetterJobData {
  reasonCode: EmailDeadLetterReasonCode;
  detail: string;
  originalJobId: string;
  rawData: EmailQueueJob;
}

const COMPLETED_RETENTION = { count: 500, age: 24 * 3600 };
const FAILED_RETENTION = { count: 500, age: 7 * 24 * 3600 };

function logQueueError(name: string) {
  return (err: Error) => console.error(`[${name}] queue-level connection error:`, err.message);
}

export const emailQueue = new Queue<EmailQueueJob, void, EmailJobType>(EMAIL_QUEUE_NAME, {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "custom" }, // resolved by the WORKER's backoffStrategy — mirrors audit.worker.ts
    removeOnComplete: COMPLETED_RETENTION,
    removeOnFail: FAILED_RETENTION,
  },
});

export const deadLetterEmailQueue = new Queue<EmailDeadLetterJobData>(DEAD_LETTER_EMAIL_QUEUE_NAME, {
  connection: redis,
});

emailQueue.on("error", logQueueError(EMAIL_QUEUE_NAME));
deadLetterEmailQueue.on("error", logQueueError(DEAD_LETTER_EMAIL_QUEUE_NAME));

/**
 * Deterministic per-intent jobId . Re-enqueuing the
 * SAME logical email while the original job is still waiting/active/
 * delayed is naturally deduplicated by BullMQ — mirrors the audit
 * queue's jobId: payload.id pattern. Once the original job COMPLETES
 * and is removed, the same jobId is free again — a legitimate resend
 * still works.
 */
export function verificationEmailJobId(userId: string): string {
  return `verification:${userId}`;
}

/**
 * The one safe entry point for enqueueing a verification email.
 * Fire-and-forget, mirrors enqueueAuditEvent()'s contract exactly:
 * never awaited on the hot path, never throws.
 */
export function enqueueVerificationEmail(params: { userId: string; email: string; token: string }): void {
  const payload: EmailQueueJob = { type: "verification", email: params.email, token: params.token };
  emailQueue.add("verification", payload, { jobId: verificationEmailJobId(params.userId) }).catch((err) => {
    console.warn(`[email] failed to enqueue verification email for user ${params.userId}:`, err);
  });
}