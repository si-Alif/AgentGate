import { Prisma, PrismaClient } from "@prisma/client";
export type DbClient = Prisma.TransactionClient | PrismaClient;