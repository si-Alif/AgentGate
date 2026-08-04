// src/__tests__/email-health.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { getEmailHealth, registerEmailWorkerForHealth } from "../lib/email/email-health.js";
import { emailQueue, deadLetterEmailQueue } from "../queue/email.queue.js";
import type { Worker } from "bullmq";

function mockWorker(isRunning: boolean): Worker {
  return { isRunning: () => isRunning } as unknown as Worker;
}

describe("getEmailHealth", () => {
  beforeEach(() => { vi.restoreAllMocks(); registerEmailWorkerForHealth(null as unknown as Worker); });

  it("WORKER_NOT_RUNNING when unregistered", async () => {
    expect((await getEmailHealth()).reason).toBe("WORKER_NOT_RUNNING");
  });

  it("HEALTHY under normal conditions", async () => {
    registerEmailWorkerForHealth(mockWorker(true));
    vi.spyOn(emailQueue, "getWaitingCount").mockResolvedValue(1);
    vi.spyOn(emailQueue, "getActiveCount").mockResolvedValue(0);
    vi.spyOn(emailQueue, "getDelayedCount").mockResolvedValue(0);
    vi.spyOn(deadLetterEmailQueue, "getWaitingCount").mockResolvedValue(0);
    expect(await getEmailHealth()).toMatchObject({ healthy: true, reason: "HEALTHY" });
  });

  it("DEAD_LETTERS_PRESENT when dead-letters exist", async () => {
    registerEmailWorkerForHealth(mockWorker(true));
    vi.spyOn(emailQueue, "getWaitingCount").mockResolvedValue(0);
    vi.spyOn(emailQueue, "getActiveCount").mockResolvedValue(0);
    vi.spyOn(emailQueue, "getDelayedCount").mockResolvedValue(0);
    vi.spyOn(deadLetterEmailQueue, "getWaitingCount").mockResolvedValue(2);
    expect(await getEmailHealth()).toMatchObject({ healthy: false, reason: "DEAD_LETTERS_PRESENT", deadLetterCount: 2 });
  });
});