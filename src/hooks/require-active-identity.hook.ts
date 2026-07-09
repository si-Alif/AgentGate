import type { FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "../lib/prisma.js";
import { getTenantContext } from "../lib/request-context.js";

/**
 * Require Active Identity Hook
 *
 * Runs after authenticate + attachTenantContext.
 * Re-verifies against Postgres that the tenant and user backing this JWT
 * are still active, then caches the resolved row on request.activeUser.
 */
export async function requireActiveIdentity(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  // getTenantContext throws if attachTenantContext didn't run or didn't
  // populate the context — that's an internal ordering bug, not a client
  // error, so let it flow to the global error handler as a 500 rather
  // than misrepresenting it as a 401 here.
  const { tenantId, userId } = getTenantContext(request);

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