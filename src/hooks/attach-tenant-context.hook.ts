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
  _reply: FastifyReply,
) {
  const payload = request.user as {
    tenantId: string;
    userId: string;
    role: "owner" | "admin" | "member";
  };

  request.tenantContext = {
    tenantId: payload.tenantId,
    userId: payload.userId,
    role: payload.role,
  } satisfies TenantContext;
}