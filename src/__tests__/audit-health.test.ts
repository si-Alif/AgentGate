import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getAuditHealth, registerAuditWorkerForHealth } from "../lib/audit-health.js";
import { auditQueue, deadLetterAuditQueue } from "../queue/audit.queue.js";
import type { Worker } from "bullmq";

// Helper to create a mock worker
function mockWorker(isRunning: boolean): Worker {
  return { isRunning: () => isRunning } as unknown as Worker;
}

describe("getAuditHealth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset the registered worker to null
    registerAuditWorkerForHealth(null as unknown as Worker);
  });

  it("returns WORKER_NOT_RUNNING when no worker registered", async () => {
    registerAuditWorkerForHealth(null as unknown as Worker);
    const result = await getAuditHealth();
    expect(result.healthy).toBe(false);
    expect(result.reason).toBe("WORKER_NOT_RUNNING");
    expect(result.workerRunning).toBe(false);
    expect(result.queueDepth).toBe(0);
    expect(result.deadLetterCount).toBe(0);
  });

  it("returns WORKER_NOT_RUNNING when worker.isRunning() is false", async () => {
    registerAuditWorkerForHealth(mockWorker(false));
    const result = await getAuditHealth();
    expect(result.reason).toBe("WORKER_NOT_RUNNING");
  });

  it("returns HEALTHY when all metrics are low and no dead letters", async () => {
    registerAuditWorkerForHealth(mockWorker(true));
    vi.spyOn(auditQueue, "getWaitingCount").mockResolvedValue(2);
    vi.spyOn(auditQueue, "getActiveCount").mockResolvedValue(3);
    vi.spyOn(auditQueue, "getDelayedCount").mockResolvedValue(1);
    vi.spyOn(deadLetterAuditQueue, "getWaitingCount").mockResolvedValue(0);

    const result = await getAuditHealth();
    expect(result.healthy).toBe(true);
    expect(result.reason).toBe("HEALTHY");
    expect(result.queueDepth).toBe(6);
  });

  it("returns DEAD_LETTERS_PRESENT when dead‑letter count > 0", async () => {
    registerAuditWorkerForHealth(mockWorker(true));
    vi.spyOn(auditQueue, "getWaitingCount").mockResolvedValue(0);
    vi.spyOn(auditQueue, "getActiveCount").mockResolvedValue(0);
    vi.spyOn(auditQueue, "getDelayedCount").mockResolvedValue(0);
    vi.spyOn(deadLetterAuditQueue, "getWaitingCount").mockResolvedValue(1);

    const result = await getAuditHealth();
    expect(result.reason).toBe("DEAD_LETTERS_PRESENT");
    expect(result.healthy).toBe(false);
    expect(result.deadLetterCount).toBe(1);
  });

  it("returns QUEUE_BACKPRESSURE when depth > 1000 and no dead letters", async () => {
    registerAuditWorkerForHealth(mockWorker(true));
    vi.spyOn(auditQueue, "getWaitingCount").mockResolvedValue(500);
    vi.spyOn(auditQueue, "getActiveCount").mockResolvedValue(300);
    vi.spyOn(auditQueue, "getDelayedCount").mockResolvedValue(201); // total 1001
    vi.spyOn(deadLetterAuditQueue, "getWaitingCount").mockResolvedValue(0);

    const result = await getAuditHealth();
    expect(result.reason).toBe("QUEUE_BACKPRESSURE");
    expect(result.healthy).toBe(false);
  });

  it("returns METRICS_TIMEOUT when the metrics call hangs", async () => {
    registerAuditWorkerForHealth(mockWorker(true));
    // Never resolve – the internal withTimeout will abort after 2 s
    vi.spyOn(auditQueue, "getWaitingCount").mockImplementation(
      () => new Promise(() => { }),
    );

    const result = await getAuditHealth();
    expect(result.reason).toBe("METRICS_TIMEOUT");
    expect(result.healthy).toBe(false);
  }, 10_000); // increase test timeout because the real withTimeout waits 2 s

  it("returns METRICS_ERROR on immediate Redis rejection", async () => {
    registerAuditWorkerForHealth(mockWorker(true));
    vi.spyOn(auditQueue, "getWaitingCount").mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await getAuditHealth();
    expect(result.reason).toBe("METRICS_ERROR");
    expect(result.healthy).toBe(false);
  });

  it("defensive guard: internal throw → METRICS_ERROR", async () => {
    registerAuditWorkerForHealth(mockWorker(true));
    // Force an error in isRunning
    const badWorker = {
      isRunning: () => { throw new Error("boom"); },
    } as unknown as Worker;
    registerAuditWorkerForHealth(badWorker);

    const result = await getAuditHealth();
    expect(result.reason).toBe("METRICS_ERROR");
    expect(result.healthy).toBe(false);
    expect(result.workerRunning).toBe(false);
  });
});