import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { env } from "../config/env.js";
import { withApplicationName } from "./pg-connection-string.js";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};


export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    // TODO : define max connection pool size
    adapter: new PrismaPg({
      connectionString: withApplicationName(env.AGENTGATE_DATABASE_URL, "agentgate-main"),
      max : env.AGENTGATE_DB_POOL_MAX,
    }),
    log: ["error", "warn"],
  });

if (env.AGENTGATE_NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}