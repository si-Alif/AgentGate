import { getTenantContext } from "../lib/request-context.js";
import type { FastifyRequest, FastifyReply } from "fastify";
import type { Role } from "../lib/roles.js";

export function requireRole(...allowedRoles: readonly Role[]) {
  return async function requireRoleHook(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { role } = getTenantContext(request);
    if (!allowedRoles.includes(role as Role)) {
      return reply.forbidden(`This action requires one of the following roles: ${allowedRoles.join(", ")}.`);
    }
  };
}

