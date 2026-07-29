import { Queue } from "bullmq";
import { redis } from "../lib/redis.js";
import type { AuditJobPayload } from "../lib/audit-schema.js";

export const AUDIT_QUEUE_NAME = "audit";
export const DEAD_LETTER_QUEUE_NAME = "dead-letter-audit";

// for instructing bullmq to keep only the most recent N completed jobs, and to expire completed jobs older than M seconds
const COMPLETED_JOB_RETENTION_COUNT = 1_000;
const COMPLETED_JOB_RETENTION_AGE_SECONDS = 24 * 3600;
// for instructing bullmq to keep only the most recent N failed jobs, and to expire failed jobs older than M seconds
const FAILED_JOB_RETENTION_COUNT = 1_000;
const FAILED_JOB_RETENTION_AGE_SECONDS = 7 * 24 * 3600;

export type DeadLetterReasonCode = "SCHEMA_VALIDATION_FAILED" | "INFRA_FAILURE_EXHAUSTED";


export interface DeadLetterJobData {
  reasonCode: DeadLetterReasonCode;
  detail: unknown;
  originalJobId: string;
  rawData: unknown;
}

function logQueueError(queueName: string): (err: Error) => void {
  return (err: Error) => {
    console.error(`[${queueName}] queue-level connection error:`, err.message);
  };
};


export const auditQueue = new Queue<AuditJobPayload, void, AuditJobPayload["eventType"]>(AUDIT_QUEUE_NAME, {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "custom" },
    removeOnComplete: { count: COMPLETED_JOB_RETENTION_COUNT, age: COMPLETED_JOB_RETENTION_AGE_SECONDS },
    removeOnFail: { count: FAILED_JOB_RETENTION_COUNT, age: FAILED_JOB_RETENTION_AGE_SECONDS },
  },
});


export const deadLetterAuditQueue = new Queue<DeadLetterJobData>(DEAD_LETTER_QUEUE_NAME, {
  connection: redis,
});


// if some error occurs at the queue level (e.g. Redis connection failure), log it to console.error so that the process doesn't silently fail
auditQueue.on("error", logQueueError(AUDIT_QUEUE_NAME));
deadLetterAuditQueue.on("error", logQueueError(DEAD_LETTER_QUEUE_NAME));