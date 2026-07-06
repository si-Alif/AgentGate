import Fastify from "fastify";
import sensible from "@fastify/sensible";
import { env } from "./config/env.js";
import healthRoutes from "./routes/healthcheck.js";
import { registerRoutes } from "./routes/auth/register.js";

export async function createApp() {
  const logger: Record<string, unknown> = {
    level: env.AGENTGATE_LOG_LEVEL,
  };

  if (env.AGENTGATE_NODE_ENV === "development") {
    logger.transport = {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "yyyy-mm-dd HH:MM:ss.l o",
        ignore: "pid,hostname",
      },
    };
  }

  const app = Fastify({ logger });

  // ═══════════════════════════════════════════════════════
  // Phase 1 — Infrastructure plugins (Week 1+)
  // ═══════════════════════════════════════════════════════
  // Will be added incrementally as each plugin is built:
    await app.register(sensible);
  //   await app.register(tenantContextPlugin)
  //   etc.

  // ═══════════════════════════════════════════════════════
  // Phase 2 — Public routes (no auth)
  // ═══════════════════════════════════════════════════════
  await app.register(healthRoutes);

  await app.register(registerRoutes, { prefix: '/auth' })

  // ═══════════════════════════════════════════════════════
  // Phase 3 — Protected REST scope (JWT + TenantContext)
  // ═══════════════════════════════════════════════════════
  // Added in Week 1+ when auth routes exist.

  // ═══════════════════════════════════════════════════════
  // Phase 4 — MCP Gateway scope (API key auth)
  // ═══════════════════════════════════════════════════════
  // Added in Week 6.

  // ═══════════════════════════════════════════════════════
  // Phase 5 — Observability scope (JWT auth, WebSocket)
  // ═══════════════════════════════════════════════════════
  // Added in Week 7.

  return app;
}



