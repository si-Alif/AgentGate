import type { Worker } from "bullmq";
import { emailQueue, deadLetterEmailQueue } from "../../queue/email.queue.js";
import { withTimeout } from "../timeout.js";
import { TimeoutError } from "../../handlers/types.js";

export type EmailHealthReason =
  | "WORKER_NOT_RUNNING" | "METRICS_TIMEOUT" | "METRICS_ERROR"
  | "DEAD_LETTERS_PRESENT" | "QUEUE_BACKPRESSURE" | "HEALTHY";

export interface EmailHealth {
  healthy: boolean;
  reason: EmailHealthReason;
  workerRunning: boolean;
  queueDepth: number;
  deadLetterCount: number;
}

let workerRef: Worker | null = null;
export function registerEmailWorkerForHealth(worker: Worker): void { workerRef = worker; }

const METRICS_TIMEOUT_MS = 2_000; // matches getAuditHealth()'s precedent, Week 5
const BACKPRESSURE_THRESHOLD = 1000;

export async function getEmailHealth(): Promise<EmailHealth> {
  try {
    const workerRunning = workerRef?.isRunning() ?? false;
    if (!workerRunning) {
      return { healthy: false, reason: "WORKER_NOT_RUNNING", workerRunning, queueDepth: 0, deadLetterCount: 0 };
    }

    let waiting: number, active: number, delayed: number, deadWaiting: number;
    try {
      [waiting, active, delayed, deadWaiting] = await withTimeout(
        () => Promise.all([
          emailQueue.getWaitingCount(),
          emailQueue.getActiveCount(),
          emailQueue.getDelayedCount(),
          deadLetterEmailQueue.getWaitingCount(),
        ]),
        METRICS_TIMEOUT_MS
      );
    } catch (err) {
      const reason: EmailHealthReason = err instanceof TimeoutError ? "METRICS_TIMEOUT" : "METRICS_ERROR";
      return { healthy: false, reason, workerRunning, queueDepth: 0, deadLetterCount: 0 };
    }

    const queueDepth = waiting + active + delayed;
    if (deadWaiting > 0) {
      return { healthy: false, reason: "DEAD_LETTERS_PRESENT", workerRunning, queueDepth, deadLetterCount: deadWaiting };
    }
    if (queueDepth > BACKPRESSURE_THRESHOLD) {
      return { healthy: false, reason: "QUEUE_BACKPRESSURE", workerRunning, queueDepth, deadLetterCount: deadWaiting };
    }
    return { healthy: true, reason: "HEALTHY", workerRunning, queueDepth, deadLetterCount: deadWaiting };
  } catch {
    return { healthy: false, reason: "METRICS_ERROR", workerRunning: false, queueDepth: 0, deadLetterCount: 0 };
  }
}