import type { FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "../lib/prisma.js";

/**
 * Require Active Identity Hook
 *
 * Runs after authenticate + attachTenantContext.
 * Re-verifies against Postgres that the tenant and user backing this JWT
 * are still active, then caches the resolved row on request.activeUser.
 *
 * This is the enforcement point for session freshness across the protected
 * REST scope, so route handlers do not need to duplicate the soft-delete check.
 */
export async function requireActiveIdentity(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { tenantId, userId } = request.tenantContext;

  const activeUser = await prisma.user.findFirst({
    where: {
      id: userId,
      tenantId,
      deletedAt: null,
      tenant: { deletedAt: null },
    },
    select: { id: true, tenantId: true, email: true },
  });

  if (!activeUser) {
    return reply.unauthorized("Account or tenant is no longer active");
  }

  request.activeUser = {
    userId: activeUser.id,
    tenantId: activeUser.tenantId,
    email: activeUser.email,
  };
}