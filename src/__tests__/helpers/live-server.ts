import type { FastifyInstance } from "fastify";
import { createApp } from "../../app.js";

/**
 * Wraps a REAL, listening Fastify instance — used ONLY where a genuine
 * TCP socket matters (client-disconnect propagation, cold-start-replica
 * proof). app.inject() cannot stand in for either claim: it never opens
 * a real socket, so it can never fire a genuine 'close' event, and it
 * gives no way to reason about "which independently-constructed
 * FastifyInstance served this request" the way two real, addressable
 * servers can. See roadmap_w6_d6.md §A.4.
 */
export interface LiveServer {
  app: FastifyInstance;
  baseUrl: string;
  close: () => Promise<void>;
}

export async function startLiveServer(): Promise<LiveServer> {
  const app = await createApp();
  await app.listen({ port: 0, host: "127.0.0.1" });

  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("startLiveServer: could not determine a numeric port for the live server");
  }

  return {
    app,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => app.close(),
  };
}