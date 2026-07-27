import pg from "pg";
import type { Client as PgClient } from "pg";
import { assertSafeUrlHost, defaultDnsResolver } from "../lib/dns-security.js";
import type { DnsResolver } from "../lib/dns-security.js";
import {
  createSafePostgresStreamFactory,
  forceTerminateClient,
  parsePostgresUrl,
  redactConnectionString,
} from "../lib/postgres-utils.js";
import { executePostgresStreamingQuery } from "../lib/postgres-stream.js";
import {
  TimeoutError,
  RowLimitExceededError,
  ByteLimitExceededError,
  SsrfBlockedError,
  DEFAULT_TIMEOUT_MS,
  type HandlerResult,
  type HandlerStatus,
} from "./types.js";
import type { PostgresHandlerConfig } from "../lib/handler-config.schema.js";

const { Client } = pg;

const PG_QUERY_CANCELED = "57014";

export async function executePostgresHandler(
  config: PostgresHandlerConfig,
  inputParams: Record<string, unknown>,
  signal: AbortSignal,
  resolver: DnsResolver = defaultDnsResolver
): Promise<HandlerResult> {
  let client: PgClient | null = null;
  let forceKilled = false;
  let onAbort: (() => void) | null = null;

  try {
    const parsed = parsePostgresUrl(config.connectionString);
    const resolvedTarget = await assertSafeUrlHost({ hostname: parsed.hostname, signal }, resolver);

    const useSSL = parsed.sslMode !== "disable" && parsed.sslMode !== "allow";

    client = new Client({
      // Explicit host/port — this is what pg's internal
      // Connection.connect(port, host) actually dials. It MUST be the
      // Layer-2-validated IP, not the original hostname, or pg's own
      // connect call would silently re-resolve the hostname itself,
      // reopening the DNS-rebinding window Layer 2 exists to close.
      host: resolvedTarget.ip,
      port: parsed.port,
      user: parsed.user,
      password: parsed.password,
      database: parsed.database,
      stream: createSafePostgresStreamFactory(resolvedTarget.ip, parsed.port),
      ssl: useSSL
        ? {
          rejectUnauthorized: true,
          servername: resolvedTarget.hostname,
        }
        : false,
      connectionTimeoutMillis: 10_000,
    });

    // pg.Client is an EventEmitter. An unexpected termination (e.g.
    // our own forced socket destroy below) emits 'error'; with no
    // listener, Node throws it as an uncaught exception — often well
    // after the call that triggered it has already returned. This
    // listener exists purely to prevent that. The actual outcome for
    // the CALLER is decided by the Promise.race against the abort
    // signal below, not by this listener.
    client.on("error", () => {
      /* swallowed intentionally — see comment above */
    });

    if (signal.aborted) {
      throw new TimeoutError("Postgres execution aborted before connect");
    }

    // A single abort-tracking promise, reused across every phase
    // below. Rejecting it is what lets the handler return immediately
    // when abort fires, instead of waiting for the killed socket to
    // eventually (and unreliably) reject whatever's currently awaited.
    const abortPromise = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        forceKilled = true;
        if (client) forceTerminateClient(client);
        reject(new TimeoutError("Postgres execution aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
    // Nothing awaits abortPromise directly if it's never raced against
    // (e.g. an earlier throw) — that's fine, a never-settled/never-
    // observed pending promise doesn't produce an unhandled rejection.

    await Promise.race([client.connect(), abortPromise]);

    // Defense-in-depth DB-side backstop — not the primary timeout
    // mechanism (that's the AbortSignal -> forceTerminateClient path
    // above, which works for any caller-supplied budget regardless of
    // this fixed platform constant).
    await Promise.race([client.query(`SET statement_timeout = ${DEFAULT_TIMEOUT_MS}`), abortPromise]);

    const paramsArray = Array.isArray(inputParams.params) ? (inputParams.params as unknown[]) : [];

    const streamingQueryPromise = executePostgresStreamingQuery(client, config.query, paramsArray);
    // If abortPromise wins the race below, this promise's eventual
    // settlement (once the destroyed socket finally propagates) is
    // already accounted for — swallow it here so it can never surface
    // as an unhandled rejection later.
    streamingQueryPromise.catch(() => { });

    const rows = await Promise.race([streamingQueryPromise, abortPromise]);

    return {
      status: "success" as HandlerStatus,
      result: { rows, rowCount: rows.length },
    };
  } catch (err: unknown) {
    const error = err as { message?: string; code?: string };

    if (err instanceof RowLimitExceededError || err instanceof ByteLimitExceededError) {
      forceKilled = true;
      if (client) forceTerminateClient(client);
      return { status: "payload_too_large", error: error.message ?? "Payload limit exceeded" };
    }
    if (err instanceof SsrfBlockedError) {
      return { status: "error", error: error.message ?? "SSRF blocked" };
    }
    if (signal.aborted || err instanceof TimeoutError || error.code === PG_QUERY_CANCELED) {
      return { status: "timeout", error: "PostgreSQL query timed out" };
    }
    return {
      status: "error",
      error: redactConnectionString(error.message ?? "Unknown PostgreSQL handler error"),
    };
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
    if (client && !forceKilled) {
      try {
        await client.end();
      } catch {
        // Nothing actionable — connection may already be gone.
      }
    }
  }
}