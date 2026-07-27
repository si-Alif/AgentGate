import net from "node:net";
import type { Socket } from "node:net";
import type { Client } from "pg";
import { CONNECTION_TIMEOUT_MS } from "../handlers/types.js";

/**
 * Returns a factory pg calls to obtain its socket. MUST return a
 * BARE, unconnected net.Socket — pg's own Connection.connect(port,
 * host), invoked internally during client.connect(), drives the
 * actual TCP connect using the Client config's host/port (which
 * postgres-handler.ts sets to the Layer-2-validated IP). Pre-
 * connecting here (as the previous version did via
 * net.connect(options)) races pg's own subsequent .connect() call and
 * throws EALREADY — nondeterministically, depending purely on
 * whether the pre-connect finishes before pg's explicit call runs.
 *
 * The idle timer is armed only for the connect phase and explicitly
 * disarmed on 'connect' — left rolling indefinitely, it would
 * eventually kill a merely-slow-to-RESPOND query and mislabel it as
 * "slow to connect." Post-connect timing is the AbortSignal's job.
 */
export function createSafePostgresStreamFactory(
  resolvedIp: string,
  port: number,
  connectTimeoutMs: number = CONNECTION_TIMEOUT_MS
): () => Socket {
  return () => {
    const socket = new net.Socket();

    socket.setTimeout(connectTimeoutMs);
    socket.once("timeout", () => {
      socket.destroy(new Error(`Connection to ${resolvedIp}:${port} timed out after ${connectTimeoutMs}ms`));
    });
    socket.once("connect", () => {
      socket.setTimeout(0); // disarm — connect succeeded, don't let this fire mid-query
    });

    return socket;
  };
}

export function forceTerminateClient(client: Client): void {
  try {
    (client as unknown as { connection?: { stream?: { destroy: () => void } } }).connection?.stream?.destroy();
  } catch {
    // Best-effort emergency teardown — nothing actionable if even this throws.
  }
}

export interface ParsedPostgresTarget {
  hostname: string;
  port: number;
  database: string;
  user: string;
  password: string;
  sslMode: string;
}

export function parsePostgresUrl(connectionString: string): ParsedPostgresTarget {
  const url = new URL(connectionString);
  return {
    hostname: url.hostname,
    port: url.port ? parseInt(url.port, 10) : 5432,
    database: url.pathname.slice(1),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    sslMode: url.searchParams.get("sslmode") ?? "prefer",
  };
}

export function redactConnectionString(input: string): string {
  return input.replace(/(:\/\/[^:/@]+):([^@]*)@/g, "$1:***@");
}