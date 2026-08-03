import { Redis } from "ioredis";
import { env } from "../config/env.js";
import { CircuitBreaker, type BreakState } from "./circuit-breaker.js";


export interface RateLimitResult {
  allowed : boolean;
  remaining : number;
  degraded : boolean; // true when the decision is made based on degraded mode (e.g. Redis is down, so we allow the request to go through )
};


// Create a new dedicated Redis client for rate limiting , cz the bullmq client is not suitable for this purpose as it has property `maxRetryCount : null` which is not suitable for rate limiting as it will retry indefinitely
// Meanwhile for rate-limiting we want to limit the number of retries to be low and with a short commandTimeout

export const rateLimiterRedis = new Redis(
  env.AGENTGATE_REDIS_URL , {
    maxRetriesPerRequest: 1,
    commandTimeout: 1000,

    retryStrategy : (times : number) => {
      return Math.min(times * 200, 2000);
    },

    reconnectOnError: (err : Error) => {
      return err.message.includes("READONLY") || err.message.includes("ECONNRESET");
    }
  }
);

rateLimiterRedis.on("error", (err) => {
  console.error("[rate-limiter-redis] connection error:", err.message);
});

declare module "ioredis" {
  interface RedisCommander<Context> {
    rateLimitIncr(key: string, ttlSeconds: string | number): Promise<number>;
  }
};

export const RATE_LIMIT_KEY_TTL_SECONDS = 120;
const AUDIT_EVENTS_READ_NAMESPACE = "audit-events-read";


rateLimiterRedis.defineCommand("rateLimitIncr", {
  numberOfKeys: 1,
  lua: `
    local current = redis.call("INCR", KEYS[1])
    if current == 1 then
      redis.call("EXPIRE", KEYS[1], ARGV[1])
    end
    return current
  `,
});

const rateLimiterCircuitBreaker = new CircuitBreaker({
  failureThreshold: 3,
  cooldownMs: 15_000
})

// Exported so tests and the /health route can both reach it without
// reimporting internals.
export function getRateLimiterBreaker(): CircuitBreaker {
  return rateLimiterCircuitBreaker;
}

//implementation check for rate limit by key

export function buildNamespacedRateLimitKey(namespace: string, identifier: string): string {
  const epochMinute = Math.floor(Date.now() / 60_000);
  return `rate:${namespace}:${identifier}:min:${epochMinute}`;
}

export function rateLimitKey(agentId: string, tenantId?: string): string {
  const epochMinute = Math.floor(Date.now() / 60_000);
  if (tenantId) {
    return `rate:tenant:${tenantId}:agent:${agentId}:min:${epochMinute}`;
  }
  return `rate:agent:${agentId}:min:${epochMinute}`;
}

async function checkRateLimitForRedisKey(key: string, limit: number): Promise<RateLimitResult> {
  if (!rateLimiterCircuitBreaker.canAttempt()) {
    console.warn(`[rate-limiter] circuit OPEN — failing closed for key ${key}`);
    return { allowed: false, remaining: 0, degraded: true };
  }

  try {
    const count = await rateLimiterRedis.rateLimitIncr(key, RATE_LIMIT_KEY_TTL_SECONDS);
    rateLimiterCircuitBreaker.onSuccess();
    return { ...evaluateRateLimit(count, limit), degraded: false };
  } catch (err) {
    rateLimiterCircuitBreaker.onFailure();

    if (rateLimiterCircuitBreaker.getState() === "OPEN") {
      console.error(`[rate-limiter] breaker tripped OPEN for key ${key}:`, err);
      return { allowed: false, remaining: 0, degraded: true };
    }

    console.warn(`[rate-limiter] degraded — failing open (below trip threshold) for key ${key}:`, err);
    return { allowed: true, remaining: limit, degraded: true };
  }
}

export function evaluateRateLimit(currentCount: number, limit: number): {allowed: boolean, remaining: number} {
  return {
    allowed: currentCount <= limit,
    remaining : Math.max( 0 , limit - currentCount ),
  }
};

export async function checkRateLimit(
  agentId: string,
  limit: number,
  tenantId?: string
): Promise<RateLimitResult> {

  return checkRateLimitForRedisKey(rateLimitKey(agentId, tenantId), limit);

}

export async function checkRateLimitByKey(key: string, limit: number): Promise<RateLimitResult> {
  return checkRateLimitByNameSpace(AUDIT_EVENTS_READ_NAMESPACE, key, limit);
}

export async function checkRateLimitByNameSpace(
  namespace: string,
  identifier: string,
  limit: number
): Promise<RateLimitResult> {
  return checkRateLimitForRedisKey(buildNamespacedRateLimitKey(namespace, identifier), limit);
}

export function getRateLimiterHealth(): {
  healthy: boolean;
  breakerState: BreakState;
}{
  const state = rateLimiterCircuitBreaker.getState();
  return { healthy: state !== "OPEN", breakerState: state };
}
