import Fastify, { type FastifyInstance, type FastifyError } from "fastify";
import sensible from "@fastify/sensible";
import jwt from "@fastify/jwt";

import { env } from "./config/env.js";
import tenantContextPlugin from "./plugins/tenant-context.plugin.js";


import healthRoutes from "./routes/healthcheck.js";
import { registerRoutes } from "./routes/auth/register.js";
import { loginRoutes } from "./routes/auth/login.js";
import { refreshRoutes } from "./routes/auth/refresh.js";
import { logoutRoutes } from "./routes/auth/logout.js";
import { agentRoutes } from "./routes/agents.js";
import { toolRoutes } from "./routes/tools.js";

import { authenticate } from "./hooks/authenticate.hook.js";
import { attachTenantContext } from "./hooks/attach-tenant-context.hook.js";
import { requireActiveIdentity } from "./hooks/require-active-identity.hook.js";
import { getTenantContext,getActiveUser } from "./lib/request-context.js";

export async function createApp(): Promise<FastifyInstance> {
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

  const app = Fastify({
    logger,
    ajv: {
      customOptions: {
        removeAdditional: false, // REQUIRED for additionalProperties:false to actually
        // reject requests instead of silently stripping fields —
        // this is what makes the PATCH isActive-bypass test (and
        // every other additionalProperties:false schema) mean
        // what it says.
        allErrors: true,
        coerceTypes: true,
        useDefaults: true,
      },
    },
  });

  // ═══════════════════════════════════════════════════════
  // Global error handler — must be registered before routes.
  // Errors already carrying an intentional client-facing status
  // (400/401/403/404/409 from @fastify/sensible or schema validation)
  // pass through as-is. Anything else — unexpected exceptions, Prisma
  // errors, DB/Redis connectivity issues, hook-ordering bugs — is
  // logged with full detail server-side and never echoed to the client.
  // ═══════════════════════════════════════════════════════
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error.statusCode && error.statusCode < 500) {
      return reply.status(error.statusCode).send({
        statusCode: error.statusCode,
        error: error.name,
        message: error.message,
      });
    }

    request.log.error({ err: error }, "Unhandled error");
    return reply.status(500).send({
      statusCode: 500,
      error: "Internal Server Error",
      message: "An unexpected error occurred",
    });
  });

  // ═══════════════════════════════════════════════════════
  // Phase 1 — Infrastructure plugins (Week 1+)
  // ═══════════════════════════════════════════════════════
  await app.register(sensible);

  await app.register(jwt, {
    secret: env.AGENTGATE_JWT_SECRET,
    sign: {
      expiresIn: "15m",
    },
  });

  await app.register(tenantContextPlugin);

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
  await app.register(async (scope) => {
    scope.addHook("preHandler", authenticate);
    scope.addHook("preHandler", attachTenantContext);
    scope.addHook("preHandler", requireActiveIdentity);

    // Day 5 boundary proof endpoint (token-derived)
    scope.get(
      "/api/me",
      {
        schema: {
          response: {
            200: {
              type: "object",
              required: ["tenantId", "userId", "role"],
              properties: {
                tenantId: { type: "string" },
                userId: { type: "string" },
                role: { type: "string" },
              },
            },
          },
        },
      },
      async (request) => {
        const ctx = getTenantContext(request);
        return {
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          role: ctx.role,
        };
      }
    );

    // Day 6 isolation proof endpoint (DB tenant-scoped read)
    scope.get(
      "/api/me/details",
      {
        schema: {
          response: {
            200: {
              type: "object",
              required: ["tenantId", "userId", "email"],
              properties: {
                tenantId: { type: "string" },
                userId: { type: "string" },
                email: { type: "string" },
              },
            },
          },
        },
      },
      async (request) => {
        return getActiveUser(request);
      }
    );

    await scope.register(agentRoutes, { prefix: "/api/agents" });
    await scope.register(toolRoutes, { prefix: "/api/tools" });

  });

  // ═══════════════════════════════════════════════════════
  // Phase 4 — MCP Gateway scope (API key auth) — Week 6
  // Phase 5 — Observability scope (JWT auth, WebSocket) — Week 7
  // ═══════════════════════════════════════════════════════

  return app;
}