import {Redis} from "ioredis";
import { env } from "../config/env.js";

const globalForRedis = globalThis as unknown as {
  redis: Redis | undefined;
};


export const redis =
  globalForRedis.redis ??
  new Redis(env.AGENTGATE_REDIS_URL, {
    // Required by BullMQ Workers — without this, ioredis throws when a
    // blocking command (used internally for job processing) can't connect.
    maxRetriesPerRequest: null,
    connectionName: "agentgate:main",
    // Reconnect with backoff instead of crashing the process on a blip.
    retryStrategy: (times) => Math.min(times * 200, 5000),
    reconnectOnError: () => true,
  });

redis.on("error", (err) => {
  // A Redis hiccup must never take down the gateway process.
  console.error("[redis] connection error:", err.message);
});

if (env.AGENTGATE_NODE_ENV !== "production") {
  globalForRedis.redis = redis;
}