import type { FastifyInstance } from "fastify";
import {  getRateLimiterHealth } from "../lib/rate-limiter.js";

/**
 * Health Check Route
 *
 * Always public — no authentication.
 * Used by Docker HEALTHCHECK, Railway/Render uptime monitors,
 * and CI pipeline smoke tests.
 *
 * In Week 8, extend this to check DB and Redis connectivity:
 *   await fastify.db.$queryRaw`SELECT 1`
 *   await fastify.redis.ping()
 */
export default async function healthRoutes(fastify: FastifyInstance) {

  fastify.get("/healthcheck", async () => ({
    status: "ok",
    timestamp: new Date().toISOString(),
    rateLimiter: getRateLimiterHealth(),
  }));
}