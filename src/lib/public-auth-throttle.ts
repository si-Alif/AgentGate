import type { FastifyRequest, FastifyReply } from "fastify";
import { checkRateLimitByNameSpace } from "./rate-limiter.js";
import { env } from "../config/env.js";

const PUBLIC_AUTH_RATE_NAMESPACE = "public-auth";

export type PublicAuthRoute = "register-tenant" | "register-user" | "login";

//
export function createPublicAuthThrottleHook(routeName: PublicAuthRoute) {
  return async function publicAuthThrottleHook(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const identifier = `${request.ip}:${routeName}`;
    const result = await checkRateLimitByNameSpace(
      PUBLIC_AUTH_RATE_NAMESPACE,
      identifier,
      env.AGENTGATE_PUBLIC_AUTH_RATE_LIMIT
    );

    if (!result.allowed) {

      if (result.degraded) {
        return reply.status(503).send({
          statusCode: 503,
          error: "service_degraded",
          message: "This endpoint is temporarily degraded. Retry shortly.",
        });
      }
      return reply.status(429).send({
        statusCode: 429,
        error: "rate_limited",
        message: "Too many requests. Retry after your rate limit window resets.",
      });

    }
    // allowed (including the primitive's own bounded fail-open case
    // below the breaker's trip threshold) — fall through to the real
    // route handler unchanged.
  };
}