// src/__tests__/helpers/setup.ts
import dotenv from "dotenv";
import path from "path";

// Force load .env.test and override any empty local .env placeholders
dotenv.config({ path: path.resolve(process.cwd(), ".env.test"), override: true });

import { afterAll } from "vitest";
import { prisma } from "../../lib/prisma.js";
import { auditPrisma } from "../../lib/audit-prisma.js";
import { redis } from "../../lib/redis.js";
import { rateLimiterRedis } from "../../lib/rate-limiter.js";
import { closeTenantEventSubscriber } from "../../observability/ws-tenant-registry.js";

afterAll(async () => {
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