import type { FastifyRequest, FastifyReply } from "fastify";
import type { TenantContext } from "../types/fastify.js";

/**
 * Attach TenantContext Hook
 *
 * Runs AFTER `authenticate.hook` has verified the JWT.
 * Reads the decoded JWT payload and writes it onto
 * `request.tenantContext` so every downstream route handler
 * and service has access to the current tenant and user.
 *
 * All DB queries in repositories MUST filter by
 * `request.tenantContext.tenantId` — this is the
 * single point of tenant isolation enforcement.
 */
export async function attachTenantContext(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const payload = request.user as Partial<{
    tenantId: string;
    userId: string;
    role: "owner" | "admin" | "member";
  }> | undefined;

  // Fail closed: if any of the required identity claims are missing,
  // do not set tenantContext and reject the request as unauthorized.
  if (!payload || typeof payload.tenantId !== "string" || !payload.tenantId || typeof payload.userId !== "string" || !payload.userId || typeof payload.role !== "string" || !payload.role) {
    return reply.unauthorized("Malformed token — missing required claims");
  }

  request.tenantContext = {
    tenantId: payload.tenantId,
    userId: payload.userId,
    role: payload.role as "owner" | "admin" | "member",
  } satisfies TenantContext;
}