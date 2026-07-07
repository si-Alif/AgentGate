import Fastify from "fastify";
import sensible from "@fastify/sensible";
import jwt from "@fastify/jwt";
import { env } from "./config/env.js";
import healthRoutes from "./routes/healthcheck.js";
import { registerRoutes } from "./routes/auth/register.js";
import { loginRoutes } from "./routes/auth/login.js";
import { refreshRoutes } from "./routes/auth/refresh.js";
import { logoutRoutes } from "./routes/auth/logout.js";
import tenantContextPlugin from "./plugins/tenant-context.plugin.js";
import { authenticate } from "./hooks/authenticate.hook.js";
import { attachTenantContext } from "./hooks/attach-tenant-context.hook.js";

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

  // JWT plugin (foundation for authenticate hook)
  await app.register(jwt, {
    secret: env.AGENTGATE_JWT_SECRET,
    sign: {
      expiresIn: "15m",
    },
  });
  // TenantContext decorator (required so TypeScript can write request.tenantContext)
  await app.register(tenantContextPlugin);
  //   etc.

  // ═══════════════════════════════════════════════════════
  // Phase 2 — Public routes (no auth)
  // ═══════════════════════════════════════════════════════
  await app.register(healthRoutes);

  await app.register(registerRoutes, { prefix: "/auth" });
  await app.register(loginRoutes, { prefix: "/auth" });
  await app.register(refreshRoutes, { prefix: "/auth" });
  await app.register(logoutRoutes, { prefix: "/auth" });

  // ═══════════════════════════════════════════════════════
  // Phase 3 — Protected REST scope (JWT + TenantContext)
  // ═══════════════════════════════════════════════════════
  // Week 4 endpoint proof: /api/ping
  await app.register(
    async (scope) => {
      scope.addHook("preHandler", authenticate);
      scope.addHook("preHandler", attachTenantContext);

      scope.get(
        "/api/ping",
        {
          schema: {
            response: {
              200: {
                type: "object",
                properties: {
                  message: { type: "string" },
                  tenantId: { type: "string" },
                  userId: { type: "string" },
                  role: { type: "string" },
                },
              },
            },
          },
        },
        async (request) => {
          return {
            message: "pong",
            tenantId: request.tenantContext!.tenantId,
            userId: request.tenantContext!.userId,
            role: request.tenantContext!.role,
          };
        }
      );
    }
  );

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



