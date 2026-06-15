import { createApp } from "./app.js";
import { env } from "./config/env.js";

async function startServer() {
  const app = await createApp();

  // ─────────────────────────────────────────────────────────
  // Graceful shutdown — drains in-flight requests, closes
  // DB connections, and lets BullMQ jobs complete before exit.
  // Required by Docker/Railway/Render (SIGTERM) and dev Ctrl+C (SIGINT).
  // ─────────────────────────────────────────────────────────
  const shutdown = async (signal: string) => {
    app.log.info(`Received ${signal} — initiating graceful shutdown...`);
    try {
      await app.close();
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