import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { redis } from "./lib/redis.js";
import { prisma } from "./lib/prisma.js";
import { rateLimiterRedis } from "./lib/rate-limiter.js";
import { emailQueue } from "./queue/email.queue.js";
import { createEmailWorker } from "./workers/email.worker.js";
import { deadLetterEmailQueue } from "./queue/email.queue.js";
import { closeSafeAgent } from "./lib/safe-agent.js"
import { createAuditWorker } from "./workers/audit.worker.js";
import { auditQueue, deadLetterAuditQueue } from "./queue/audit.queue.js";
import { auditPrisma } from "./lib/audit-prisma.js";
import { withTimeout } from "./lib/timeout.js";
import { closeAllObservabilityConnections, closeTenantEventSubscriber } from "./observability/ws-tenant-registry.js";

async function startServer() {
  const app = await createApp();
  const emailWorker = createEmailWorker();
  const auditWorker = createAuditWorker();


  async function timedShutdownStep(label : string , fn : ()=> Promise<void> ) : Promise<void> {
    const start = performance.now();
    try{
      await fn();
    }finally {
      app.log.info({ step: label, durationMs: Math.round(performance.now() - start) }, "[shutdown] step complete");
    }
  }

  // ─────────────────────────────────────────────────────────
  // Graceful shutdown — drains in-flight requests, closes
  // DB connections, and lets BullMQ jobs complete before exit.
  // Required by Docker/Railway/Render (SIGTERM) and dev Ctrl+C (SIGINT).
  // ─────────────────────────────────────────────────────────
  const shutdown = async (signal: string) => {
    app.log.info(`Received ${signal} — initiating graceful shutdown...`);
    try {
      app.log.info("Closing observability WebSocket connections...");
      await timedShutdownStep("ws-connections", () => closeAllObservabilityConnections());

      app.log.info("Closing tenant-event subscriber connection...");

      await timedShutdownStep("tenant-event-subscriber", async () => {
        try {
          await withTimeout(() => closeTenantEventSubscriber(), 3000);
        }catch (err) {
          app.log.warn({ err }, "tenantEventSubscriber close timed out or failed — continuing shutdown");
        }
      });

      await timedShutdownStep("http-listener", () => app.close());            // 1. stop new HTTP/SSE

      await timedShutdownStep("email-worker", () => emailWorker.close());
      await timedShutdownStep("email-queues", async () => {    // 2. drain email
        await emailQueue.close();
        await deadLetterEmailQueue.close();
      });
      // 3. Bounded audit worker shutdown
      app.log.info("Draining audit worker...");

      await timedShutdownStep("audit-worker", async () => {
        try {
          // Gracefully wait up to 3 s for the active job
          await withTimeout(() => auditWorker.close(), 3000);
        } catch (err: any) {
          if (err.name === "TimeoutError") {
            app.log.warn("Audit worker drain timed out, forcing close...");
            await auditWorker.close(true);
          } else {
            app.log.error(err, "Error closing audit worker");
          }
        }
      });

      await timedShutdownStep("audit-queues", async () => {
        await auditQueue.close();
        await deadLetterAuditQueue.close();
      });

      await timedShutdownStep("audit-prisma-disconnect", async () => {
        try{
          await auditPrisma.$disconnect(); // dedicated pool
        }
        catch(err) {
          app.log.warn({ err }, "auditPrisma.$disconnect() failed — continuing shutdown");
        }
      });

      await timedShutdownStep("rate-limiter-redis-quit", async () => {
        try {
          await rateLimiterRedis.quit(); // 4. rate limiter Redis
        }catch(err){
          app.log.warn({ err }, "rateLimiterRedis.quit() failed — continuing shutdown");
        }
      });

      await timedShutdownStep("shared-redis-quit", async () => {
        try {
          await redis.quit();            // 5. main Redis (after all BullMQ consumers)
        }catch(err){
          app.log.warn({ err }, "redis.quit() failed — continuing shutdown");
        }
      });

      await timedShutdownStep("main-prisma-disconnect", async () => {
        try{
          await prisma.$disconnect();    // 6. main Postgres
        }catch(err){
          app.log.warn({ err }, "prisma.$disconnect() failed — continuing shutdown");
        }
      })

      await timedShutdownStep("safe-http-agent", () => closeSafeAgent());        // 7. outbound HTTP

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