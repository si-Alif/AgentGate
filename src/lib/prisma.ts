import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { env } from "../config/env.js";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};



export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    // TODO : define max connection pool size
    adapter: new PrismaPg({ connectionString: env.AGENTGATE_DATABASE_URL }),
    log: ["error", "warn"],
  });

if (env.AGENTGATE_NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}