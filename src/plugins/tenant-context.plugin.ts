import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";

/**
 * Tenant Context Plugin
 *
 * Declares the `request.tenantContext` decorator with a null default.
 * The actual value is populated by the `attach-tenant-context.hook`
 * after JWT verification in the protected scope.
 *
 * This is a SEPARATE concern from the hook because:
 * - Fastify requires `decorateRequest` to be registered before any
 *   hook or route tries to access the property.
 * - The hook is applied only to protected routes, but the decorator
 *   must exist globally so TypeScript doesn't complain.
 */
export default fp(async function tenantContextPlugin(fastify: FastifyInstance) {
  fastify.decorateRequest("tenantContext", null);
  fastify.decorateRequest("activeUser", null);
}, {
  name: "tenant-context",
});