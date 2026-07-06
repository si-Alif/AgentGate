import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { emailQueue } from "./queue/email.queue.js";
import { createEmailWorker } from "./workers/email.worker.js";
import { redis } from "./lib/redis.js";
import { prisma } from "./lib/prisma.js";

async function startServer() {
  const app = await createApp();

  const emailWorker = createEmailWorker();
  // ─────────────────────────────────────────────────────────
  // Graceful shutdown — drains in-flight requests, closes
  // DB connections, and lets BullMQ jobs complete before exit.
  // Required by Docker/Railway/Render (SIGTERM) and dev Ctrl+C (SIGINT).
  // ─────────────────────────────────────────────────────────
  const shutdown = async (signal: string) => {
    app.log.info(`Received ${signal} — initiating graceful shutdown...`);
    try {
      await app.close();            // 1. stop accepting new HTTP/SSE connections
      await emailWorker.close();    // 2. drain in-flight jobs, stop consuming new ones
      await emailQueue.close();
      await redis.quit();           // 3. close Redis
      await prisma.$disconnect();   // 4. close Postgres
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