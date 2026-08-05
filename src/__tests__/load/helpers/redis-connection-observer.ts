import { rateLimiterRedis } from "../../../lib/rate-limiter.js";

const AGENTGATE_NAME_PREFIX = "agentgate:";

/**
 * Week 8 Day 3 — Decision 8.70. Reuses rateLimiterRedis purely as a
 * COMMAND CHANNEL to run CLIENT LIST against the shared Redis server
 * — CLIENT LIST reports every connection to that server, not just
 * ones opened by the client issuing the command, so which client runs
 * the query doesn't affect the result.
 *
 * Counts entries whose `name` field carries the agentgate: prefix
 * (Step 4's tags) — a DEFINITIVE, precise count of the 3 explicitly-
 * owned, directly-constructed clients, distinct from BullMQ's own
 * internally-duplicated (unnamed) blocking-read connections for the
 * audit and email workers, which this function reports separately as
 * a corroborating total delta.
 */
export interface RedisConnectionSnapshot {
  namedAgentgateClients: number;
  totalConnectedClients: number;
}

export async function snapshotRedisConnections(): Promise<RedisConnectionSnapshot> {
  const raw = await rateLimiterRedis.client("LIST");
  const lines = String(raw).split("\n").filter((l) => l.trim().length > 0);
  const namedAgentgateClients = lines.filter((l) => {
    const match = l.match(/(?:^|\s)name=(\S*)/);
    return match?.[1]?.startsWith(AGENTGATE_NAME_PREFIX) ?? false;
  }).length;

  const info = await rateLimiterRedis.info("clients");
  const totalMatch = info.match(/connected_clients:(\d+)/);
  const totalConnectedClients = totalMatch ? parseInt(totalMatch[1]!, 10) : lines.length;

  return { namedAgentgateClients, totalConnectedClients };
}