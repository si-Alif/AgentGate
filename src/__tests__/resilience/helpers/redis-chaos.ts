import { rateLimiterRedis } from "../../../lib/rate-limiter.js";


export function disconnectRateLimiterRedis(): void {
  rateLimiterRedis.disconnect();
}

export async function reconnectRateLimiterRedis(): Promise<void> {
  await rateLimiterRedis.connect();
}