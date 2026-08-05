import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { env } from "../config/env.js";
import { withApplicationName } from "./pg-connection-string.js";

// A dedicated pool specifically for the background audit worker.
// Prevents high-throughput logging from starving the main REST API connection pool.
const globalForAuditPrisma = globalThis as unknown as {
  auditPrisma: PrismaClient | undefined;
};

export const auditPrisma =
  globalForAuditPrisma.auditPrisma ??
  new PrismaClient({
    adapter: new PrismaPg({
      connectionString: withApplicationName(env.AGENTGATE_DATABASE_URL, "agentgate-audit"),
      max: env.AGENTGATE_AUDIT_DB_POOL_MAX,
    }),
    log: ["error", "warn"],
  });

if (env.AGENTGATE_NODE_ENV !== "production") {
  globalForAuditPrisma.auditPrisma = auditPrisma;
}