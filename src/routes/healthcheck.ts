// src/routes/healthcheck.ts
import type { FastifyInstance } from "fastify";
import { getRateLimiterHealth } from "../lib/rate-limiter.js";
import { getAuditHealth } from "../lib/audit-health.js";
import { getObservabilityStreamHealth } from "../observability/ws-tenant-registry.js";
import { getEmailHealth } from "../lib/email/email-health.js";


export default async function healthRoutes(fastify: FastifyInstance) {
  fastify.get("/healthcheck", async (request, reply) => {
    const rateLimiter = getRateLimiterHealth();
    const audit = await getAuditHealth();
    const observabilityStream = await getObservabilityStreamHealth();
    const email = await getEmailHealth();
      // Core systems (rate limiter, DB, Redis) determine overall health.
      // Audit is reported purely for observability (Option A).
    const isCoreHealthy = rateLimiter.healthy;

    return reply.status(isCoreHealthy ? 200 : 503).send({
      status: isCoreHealthy ? "ok" : "degraded",
      timestamp: new Date().toISOString(),
      rateLimiter,
      audit,
      email,
      mcpGatewayCache : rateLimiter,
      observabilityStream,
    });
  });
}