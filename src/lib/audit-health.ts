// src/lib/audit-health.ts
import type { Worker } from "bullmq";
import { auditQueue, deadLetterAuditQueue } from "../queue/audit.queue.js";
import { withTimeout } from "./timeout.js";
import { TimeoutError } from "../handlers/types.js";

export type AuditHealthReason =
  | "WORKER_NOT_RUNNING"
  | "METRICS_TIMEOUT"
  | "METRICS_ERROR"
  | "DEAD_LETTERS_PRESENT"
  | "QUEUE_BACKPRESSURE"
  | "HEALTHY";

export interface AuditHealth {
  healthy: boolean;
  reason: AuditHealthReason;
  workerRunning: boolean;
  queueDepth: number;
  deadLetterCount: number;
}

let workerRef: Worker | null = null;

export function registerAuditWorkerForHealth(worker: Worker): void {
  workerRef = worker;
}

export function getRegisteredAuditWorker(): Worker | null {
  return workerRef;
}

const BACKPRESSURE_THRESHOLD = 1000;
const METRICS_TIMEOUT_MS = 2_000;

/**
 * Defensive outer guard: this function must NEVER throw.
 * It is called directly by the /health route.
 */
export async function getAuditHealth(): Promise<AuditHealth> {
  try {
    const workerRunning = workerRef?.isRunning() ?? false;

    // 1. Cheapest, zero‑I/O check
    if (!workerRunning) {
      return {
        healthy: false,
        reason: "WORKER_NOT_RUNNING",
        workerRunning,
        queueDepth: 0,
        deadLetterCount: 0,
      };
    }

    // 2. Gather queue metrics under a single timeout
    let waiting: number, active: number, delayed: number, deadWaiting: number;
    try {
      [waiting, active, delayed, deadWaiting] = await withTimeout(
        () =>
          Promise.all([
            auditQueue.getWaitingCount(),
            auditQueue.getActiveCount(),
            auditQueue.getDelayedCount(),
            deadLetterAuditQueue.getWaitingCount(),
          ]),
        METRICS_TIMEOUT_MS,
      );
    } catch (err: unknown) {
      if (err instanceof TimeoutError) {
        return {
          healthy: false,
          reason: "METRICS_TIMEOUT",
          workerRunning,
          queueDepth: 0,
          deadLetterCount: 0,
        };
      }
      return {
        healthy: false,
        reason: "METRICS_ERROR",
        workerRunning,
        queueDepth: 0,
        deadLetterCount: 0,
      };
    }

    const queueDepth = waiting + active + delayed;
    const deadLetterCount = deadWaiting;

    // 3. Permanent failures
    if (deadLetterCount > 0) {
      return {
        healthy: false,
        reason: "DEAD_LETTERS_PRESENT",
        workerRunning,
        queueDepth,
        deadLetterCount,
      };
    }

    // 4. Leading indicator of starvation
    if (queueDepth > BACKPRESSURE_THRESHOLD) {
      return {
        healthy: false,
        reason: "QUEUE_BACKPRESSURE",
        workerRunning,
        queueDepth,
        deadLetterCount,
      };
    }

    // 5. All clear
    return {
      healthy: true,
      reason: "HEALTHY",
      workerRunning,
      queueDepth,
      deadLetterCount,
    };
  } catch (_unexpected) {
    // Outer guard – never propagate
    return {
      healthy: false,
      reason: "METRICS_ERROR",
      workerRunning: false,
      queueDepth: 0,
      deadLetterCount: 0,
    };
  }
}