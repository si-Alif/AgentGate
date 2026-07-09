import type { FastifyRequest } from "fastify";
import type { TenantContext, ActiveUser } from "../types/fastify.js";

/**
 * Use ONLY inside routes registered under the protected scope, i.e. after
 * authenticate -> attachTenantContext -> requireActiveIdentity have run.
 * Throws (rather than silently operating on null) if hook ordering was
 * ever broken for a given route — fail loud, not quiet. The thrown error
 * has no .statusCode, so the global error handler logs it server-side
 * and returns a generic 500 to the client rather than leaking detail.
 */
export function getTenantContext(request: FastifyRequest): TenantContext {
  if (!request.tenantContext) {
    throw new Error("tenantContext missing — hook ordering violated for this route");
  }
  return request.tenantContext;
}

export function getActiveUser(request: FastifyRequest): ActiveUser {
  if (!request.activeUser) {
    throw new Error("activeUser missing — hook ordering violated for this route");
  }
  return request.activeUser;
}