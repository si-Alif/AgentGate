import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { executePostgresHandler } from "../handlers/postgres-handler.js";
import * as dnsSecurity from "../lib/dns-security.js";
import type { ResolvedTarget } from "../lib/dns-security.js"; // Step 0: confirm this type name/shape — adjust if your export differs
import type { PostgresHandlerConfig } from "../lib/handler-config.schema.js";
import pg from "pg";

vi.mock("../lib/dns-security.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/dns-security.js")>();
  return {
    ...actual,
    assertSafeUrlHost: vi.fn(),
  };
});

/**
 * `sslmode=disable` is not optional here. The local docker-compose
 * Postgres (postgres:16-alpine, no TLS cert configured) cannot complete
 * a STARTTLS negotiation. Without this, `parsePostgresUrl` defaults
 * sslMode to "prefer", `useSSL` evaluates true, and every connection
 * attempt below fails during the TLS handshake — this was the actual,
 * confirmed cause of every failure except the SSRF-block test.
 */
const TEST_PG =
  process.env.AGENTGATE_TEST_DATABASE_URL ??
  "postgresql://postgres:password@localhost:5432/agentgate?sslmode=disable";

// Typed against the real ResolvedTarget so a field-name drift (e.g.
// .ip vs .ipAddress, or a missing field) fails to COMPILE here, rather
// than silently mismatching at runtime or being hidden behind `as any`.
const safeLocalTarget: ResolvedTarget = {
  ip: "127.0.0.1",
  hostname: "localhost",
  family: 4,
  allResolvedIps: ["127.0.0.1"],
};

// HandlerResult.result is `unknown` by design — handlers are
// polymorphic, so narrowing is the caller's job, not the shared type's.
// This is that narrowing, done once, with a useful failure message
// instead of a silent `any`.
interface PostgresSuccessPayload {
  rows: Record<string, unknown>[];
  rowCount: number;
}

function expectSuccessPayload(
  result: Awaited<ReturnType<typeof executePostgresHandler>>
): PostgresSuccessPayload {
  if (result.status !== "success") {
    throw new Error(
      `Expected status "success" but got "${result.status}": ${result.error ?? "(no error message)"}`
    );
  }
  return result.result as PostgresSuccessPayload;
}

// Centralizes the config shape. If PostgresHandlerConfig requires a
// field beyond {handlerType, connectionString, query} in your real
// schema, TypeScript will flag it exactly here — one place to fix,
// not scattered `as any` casts across every test.
function makeConfig(query: string): PostgresHandlerConfig {
  return { handlerType: "postgres", connectionString: TEST_PG, query };
}

describe("executePostgresHandler — SSRF Layer 2 (two-sided gate)", () => {
  beforeEach(async () => {
    const actual = await vi.importActual<typeof import("../lib/dns-security.js")>(
      "../lib/dns-security.js"
    );
    vi.mocked(dnsSecurity.assertSafeUrlHost).mockImplementation(actual.assertSafeUrlHost);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("blocks localhost by default — real resolver, no overrides", async () => {
    const result = await executePostgresHandler(makeConfig("SELECT 1"), {}, new AbortController().signal);

    expect(result.status).toBe("error");
    expect(result.error ?? "").toMatch(/SSRF blocked/i);
  });

  it("connects ONLY with an explicit, deliberate override — proves the block above wasn't accidental", async () => {
    vi.mocked(dnsSecurity.assertSafeUrlHost).mockResolvedValueOnce(safeLocalTarget);

    const result = await executePostgresHandler(
      makeConfig("SELECT 1 as one"),
      {},
      new AbortController().signal
    );

    const payload = expectSuccessPayload(result);
    expect(payload.rowCount).toBe(1);
  });
});

describe("executePostgresHandler — execution correctness", () => {
  beforeEach(() => {
    vi.mocked(dnsSecurity.assertSafeUrlHost).mockResolvedValue(safeLocalTarget);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("executes a parameterized query and returns rows", async () => {
    const result = await executePostgresHandler(
      makeConfig("SELECT $1::int as num"),
      { params: [42] },
      new AbortController().signal
    );

    const payload = expectSuccessPayload(result);
    expect(payload.rows[0]?.num).toBe(42);
  });

  it("enforces the row ceiling by streaming, not buffering, and force-terminates the connection", async () => {
    const before = await executePostgresHandler(
      makeConfig("SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()"),
      {},
      new AbortController().signal
    );
    const beforeCount = Number(expectSuccessPayload(before).rows[0]?.count);

    const ceilingResult = await executePostgresHandler(
      makeConfig("SELECT generate_series(1, 5000) as n"),
      {},
      new AbortController().signal
    );
    expect(ceilingResult.status).toBe("payload_too_large");

    // Give Postgres a moment to notice the force-terminated socket.
    await new Promise((r) => setTimeout(r, 300));

    const after = await executePostgresHandler(
      makeConfig("SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()"),
      {},
      new AbortController().signal
    );
    const afterCount = Number(expectSuccessPayload(after).rows[0]?.count);

    // No orphaned connection accumulating from the forced disconnect.
    expect(afterCount).toBeLessThanOrEqual(beforeCount + 1);
  });

  it("returns timeout status when the AbortSignal fires mid-query", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);

    const result = await executePostgresHandler(makeConfig("SELECT pg_sleep(5)"), {}, controller.signal);

    expect(result.status).toBe("timeout");
  });

  it("maps a server-side statement_timeout cancellation (57014) to status: timeout", async () => {
    // Rejects the first Client.prototype.query() call after connect() —
    // that's the "SET statement_timeout" line in the handler, not the
    // streaming query itself. Same effect for this test's purpose: it
    // proves the handler's error.code === "57014" branch actually maps
    // to "timeout", without waiting out a real 30s statement_timeout.
    const spy = vi.spyOn(pg.Client.prototype as any, "query").mockRejectedValueOnce({
      message: "canceling statement due to statement timeout",
      code: "57014",
    });

    const result = await executePostgresHandler(makeConfig("SELECT 1"), {}, new AbortController().signal);

    expect(result.status).toBe("timeout");
    expect(result.error ?? "").toMatch(/timed out/i);

    spy.mockRestore();
  });
});