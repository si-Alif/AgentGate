import { Worker } from "bullmq";
import { redis } from "../lib/redis.js";
import type { EmailQueueJob } from "../queue/email.queue.js";

export function createEmailWorker(): Worker<EmailQueueJob> {
  const worker = new Worker<EmailQueueJob>(
    "email",
    async (job) => {
      // STUB — swap for real SMTP/SendGrid delivery in Phase 2.
      console.log(`[EMAIL STUB] type=${job.data.type} to=${job.data.email}`);
      if (job.data.type === "verification") {
        console.log(`  verify url: /auth/verify-email?token=${job.data.token}`);
      }
    },
    { connection: redis }
  );

  worker.on("failed", (job, err) => {
    console.error(`[email worker] job ${job?.id} failed:`, err.message);
  });

  return worker;
}