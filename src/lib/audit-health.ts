import type { Worker } from "bullmq";

/**
 * Registration-only for today. The audit worker calls this once, at
 * creation time, so a later health check has something real to ask
 * "is the worker actually running." getAuditHealth()'s full
 * aggregation (queue depth / dead-letter count / the overall healthy
 * boolean) is Day 4's job, built on top of this registration once
 * /health itself is being wired up — there's no consumer for that
 * logic yet today, so it isn't built today.
 */
let workerRef: Worker | null = null;

export function registerAuditWorkerForHealth(worker: Worker): void {
  workerRef = worker;
}

export function getRegisteredAuditWorker(): Worker | null {
  return workerRef;
}