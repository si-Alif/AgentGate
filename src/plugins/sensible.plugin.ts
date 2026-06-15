import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import sensible from "@fastify/sensible";

/**
 * Sensible Plugin
 *
 * Provides `reply.badRequest()`, `reply.unauthorized()`,
 * `reply.notFound()`, `reply.internalServerError()`, etc.
 * and the `fastify.httpErrors` namespace.
 *
 * This eliminates boilerplate error-throwing in route handlers.
 */
export default fp(async function sensiblePlugin(fastify: FastifyInstance) {
  await fastify.register(sensible);
}, {
  name: "sensible",
});