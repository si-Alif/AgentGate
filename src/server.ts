import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { emailQueue } from "./queue/email.queue.js";
import { createEmailWorker } from "./workers/email.worker.js";
import { redis } from "./lib/redis.js";
import { prisma } from "./lib/prisma.js";
import { rateLimiterRedis } from "./lib/rate-limiter.js";
import {closeSafeAgent} from "./lib/safe-agent.js"
import { createAuditWorker } from "./workers/audit.worker.js";
import { auditQueue, deadLetterAuditQueue } from "./queue/audit.queue.js";
import { auditPrisma } from "./lib/audit-prisma.js";
import { withTimeout } from "./lib/timeout.js";

async function startServer() {
  const app = await createApp();
  const emailWorker = createEmailWorker();
  const auditWorker = createAuditWorker();
  // ─────────────────────────────────────────────────────────
  // Graceful shutdown — drains in-flight requests, closes
  // DB connections, and lets BullMQ jobs complete before exit.
  // Required by Docker/Railway/Render (SIGTERM) and dev Ctrl+C (SIGINT).
  // ─────────────────────────────────────────────────────────
  const shutdown = async (signal: string) => {
    app.log.info(`Received ${signal} — initiating graceful shutdown...`);
    try {
      await app.close();            // 1. stop new HTTP/SSE

      await emailWorker.close();    // 2. drain email
      await emailQueue.close();

      // 3. Bounded audit worker shutdown
      app.log.info("Draining audit worker...");
      try {
        // Gracefully wait up to 3 s for the active job
        await withTimeout(() => auditWorker.close(), 3000);
      } catch (err: any) {
        if (err.name === "TimeoutError") {
          app.log.warn("Audit worker drain timed out, forcing close...");
          await auditWorker.close(true);  // safe because of Day 3 idempotency
        } else {
          app.log.error(err, "Error closing audit worker");
        }
      }

      await auditQueue.close();
      await deadLetterAuditQueue.close();
      await auditPrisma.$disconnect(); // dedicated pool

      await rateLimiterRedis.quit(); // 4. rate limiter Redis
      await redis.quit();            // 5. main Redis (after all BullMQ consumers)
      await prisma.$disconnect();    // 6. main Postgres
      await closeSafeAgent();        // 7. outbound HTTP

      app.log.info("Server closed gracefully.");
      process.exit(0);
    } catch (err) {
      app.log.error(err, "Error during shutdown");
      process.exit(1);
    }
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  try {
    await app.listen({ port: env.AGENTGATE_PORT, host: "0.0.0.0" });
    app.log.info(`Server listening on port ${env.AGENTGATE_PORT}`);
  } catch (err) {
    app.log.error(err, "Failed to start server");
    process.exit(1);
  }
}

startServer();