// Prisma and Redis types — uncomment when packages are installed (Week 1 Day 2)
// import type { PrismaClient } from "@prisma/client";
// import type { Redis } from "ioredis";

import "@fastify/jwt";

declare module "fastify" {
  interface FastifyInstance {
    // db: PrismaClient;
    // redis: Redis;
    sessionMap: Map<string, unknown>;
  }

  interface FastifyRequest {
    tenantContext: TenantContext;
    activeUser: ActiveUser | null;
  }
}

declare module "@fastify/jwt" {
  interface JWTPayload {
    tenantId: string;
    userId: string;
    role: "owner" | "admin" | "member";
  }
}

export interface TenantContext {
  tenantId: string;
  userId: string;
  role: "owner" | "admin" | "member";
}

export interface ActiveUser {
  userId: string;
  tenantId: string;
  email: string;
}