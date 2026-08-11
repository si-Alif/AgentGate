// src/__tests__/helpers/setup.ts
import dotenv from "dotenv";
import path from "path";
import { afterAll } from "vitest";

// 1. Force load .env.test FIRST
dotenv.config({ path: path.resolve(process.cwd(), ".env.test"), override: true });

// 2. Use Dynamic Imports inside the hook so they evaluate AFTER dotenv runs
afterAll(async () => {
  const { prisma } = await import("../../lib/prisma.js");
  const { auditPrisma } = await import("../../lib/audit-prisma.js");
  const { redis } = await import("../../lib/redis.js");
  const { rateLimiterRedis } = await import("../../lib/rate-limiter.js");
  const { closeTenantEventSubscriber } = await import("../../observability/ws-tenant-registry.js");

  await prisma.$disconnect().catch(() => { });
  await auditPrisma.$disconnect().catch(() => { });

  if (redis.status !== "end" && redis.status !== "close") {
    await redis.quit().catch(() => { });
  }

  if (rateLimiterRedis.status !== "end" && rateLimiterRedis.status !== "close") {
    await rateLimiterRedis.disconnect();
  }

  await closeTenantEventSubscriber().catch(() => { });
});