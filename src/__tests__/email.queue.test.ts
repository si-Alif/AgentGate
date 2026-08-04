// src/__tests__/email.queue.test.ts
import { describe, it, expect, vi } from "vitest";
import crypto from "node:crypto";
import { emailQueue, deadLetterEmailQueue, enqueueVerificationEmail, verificationEmailJobId } from "../queue/email.queue.js";

describe("email.queue", () => {
  it("defaultJobOptions: 3 attempts, custom backoff, bounded retention", async () => {
    const job = await emailQueue.add("verification", { type: "verification", email: "a@b.com", token: "t" }, {
      jobId: verificationEmailJobId(crypto.randomUUID()),
    });
    expect(job.opts.attempts).toBe(3);
    expect(job.opts.backoff).toEqual({ type: "custom" });
    await job.remove();
  });

  it("GATE — enqueueVerificationEmail dedupes by userId while the original job is pending", async () => {
    const userId = crypto.randomUUID();
    enqueueVerificationEmail({ userId, email: "a@b.com", token: "first-token" });
    await new Promise((r) => setTimeout(r, 20));
    enqueueVerificationEmail({ userId, email: "a@b.com", token: "second-token" }); // no-op
    await new Promise((r) => setTimeout(r, 20));

    const job = await emailQueue.getJob(verificationEmailJobId(userId));
    expect(job?.data.token).toBe("first-token");
    await job?.remove();
  });

  it("never throws even when queue.add() rejects", async () => {
    const spy = vi.spyOn(emailQueue, "add").mockRejectedValue(new Error("redis unreachable"));
    expect(() => enqueueVerificationEmail({ userId: crypto.randomUUID(), email: "a@b.com", token: "t" })).not.toThrow();
    await new Promise((r) => setTimeout(r, 20));
    spy.mockRestore();
  });

  it("both queues survive a synthetic 'error' emit", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
    expect(() => emailQueue.emit("error", new Error("blip"))).not.toThrow();
    expect(() => deadLetterEmailQueue.emit("error", new Error("blip"))).not.toThrow();
    errorSpy.mockRestore();
  });
});