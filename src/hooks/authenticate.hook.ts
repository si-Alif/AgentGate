import type { FastifyRequest, FastifyReply } from "fastify";
import { env } from "../config/env.js";

/**
 * Authenticate Hook
 *
 * Verifies the JWT from the Authorization header using
 * `@fastify/jwt` (available as `request.jwtVerify()`).
 *
 * Apply this as a `preHandler` on any route group that requires
 * user JWT authentication (protected REST API, WebSocket stream).
 *
 * IMPORTANT: Do NOT apply this to MCP routes (/mcp/*).
 * Agents authenticate via API key using argon2 inline in the SSE handler.
 */
export async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  try {
    await request.jwtVerify();
  } catch (_err) {
    return reply.unauthorized("Invalid or expired token");
  }
}
