import type { FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";
import type { Redis } from "ioredis";
import { createApp } from "../../app.js";
import { createAuditWorker } from "../../workers/audit.worker.js";
import { auditQueue, deadLetterAuditQueue } from "../../queue/audit.queue.js";
import { createEmailWorker } from "../../workers/email.worker.js";
import { emailQueue, deadLetterEmailQueue } from "../../queue/email.queue.js";
import { auditPrisma } from "../../lib/audit-prisma.js";
import { prisma } from "../../lib/prisma.js";
import { redis } from "../../lib/redis.js";
import { rateLimiterRedis } from "../../lib/rate-limiter.js";
import { closeSafeAgent } from "../../lib/safe-agent.js";
import { withTimeout } from "../../lib/timeout.js";
import {
  closeAllObservabilityConnections,
  closeTenantEventSubscriber,
} from "../../observability/ws-tenant-registry.js";

export interface SystemHarness {
  app: FastifyInstance;
  port: number;
  auditWorker: ReturnType<typeof createAuditWorker>;
  emailWorker: ReturnType<typeof createEmailWorker>;
}

const SHUTDOWN_STEP_TIMEOUT_MS = 3000;

/**
 * Ensures Redis singletons are connected before starting a test run.
 * Essential for Vitest watch mode where singletons persist across re-runs.
 */
async function ensureRedisConnected(client: Redis): Promise<void> {
  if (!client) return;
  if (client.status === "end" || client.status === "close") {
    await client.connect();
  }
}

/**
 * Safely disconnects Redis clients without waiting for async network responses
 * that cause "Connection is closed" errors during teardown.
 */
function safeDisconnectRedis(client: Redis): void {
  if (!client) return;
  if (client.status === "end" || client.status === "close") return;

  try {
    client.disconnect();
  } catch {
    // Ignore errors if socket is already closed
  }
}

export async function startFullSystem(): Promise<SystemHarness> {
  // Re-establish Redis connections if they were closed in a previous test run
  await ensureRedisConnected(redis);
  await ensureRedisConnected(rateLimiterRedis);

  const app = await createApp();
  await app.ready();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = (app.server.address() as AddressInfo).port;

  const auditWorker = createAuditWorker();
  const emailWorker = createEmailWorker();

  return { app, port, auditWorker, emailWorker };
}

export async function stopFullSystem(harness: SystemHarness): Promise<void> {
  // 1-2. WS teardown
  await closeAllObservabilityConnections();

  try {
    await withTimeout(() => closeTenantEventSubscriber(), SHUTDOWN_STEP_TIMEOUT_MS);
  } catch (err) {
    console.warn("[system-harness] tenantEventSubscriber close timed out or failed:", err);
  }

  // 3. Stop accepting new HTTP/MCP/WS-upgrade traffic.
  await harness.app.close();

  // 4-5. Email worker and queue cleanup
  await harness.emailWorker.close();
  await emailQueue.close();
  await deadLetterEmailQueue.close();

  // 6-9. Audit infrastructure
  try {
    await withTimeout(() => harness.auditWorker.close(), SHUTDOWN_STEP_TIMEOUT_MS);
  } catch (err: any) {
    if (err?.name === "TimeoutError") {
      console.warn(
        "[system-harness] audit worker drain timed out — continuing; idempotent redelivery absorbs any in-flight job"
      );
    } else {
      console.error("[system-harness] error closing audit worker:", err);
    }
  }
  await auditQueue.close();
  await deadLetterAuditQueue.close();
  try {
    await auditPrisma.$disconnect();
  }catch(err){
    console.warn("[system-harness] auditPrisma.$disconnect() failed:", err);
  }
  // 10-13. Shared infrastructure
  safeDisconnectRedis(rateLimiterRedis);
  safeDisconnectRedis(redis);
  try {
    await prisma.$disconnect();
  }catch(err){
    console.warn("[system-harness] prisma.$disconnect() failed:", err);
  }
  await closeSafeAgent();
}