import { describe, it, expect } from "vitest";
import { executePostgresHandler } from "../handlers/postgres-handler.js";

// Day 6 finding: literal IP, not "localhost" — see Block A / §1.2.
const TEST_PG =
  process.env.AGENTGATE_TEST_DATABASE_URL ??
  "postgresql://postgres:password@localhost:5432/agentgate?sslmode=disable";

const permissive = () => ({ isSafe: true });

describe("executePostgresHandler — Layer 2, both directions in one file", () => {
  it("is blocked with no validator override (the real production default)", async () => {
    const result = await executePostgresHandler(
      { handlerType: "postgres", connectionString: TEST_PG, query: "SELECT 1" },
      {},
      new AbortController().signal
    );
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/^SSRF blocked/);
  });

  it("connects only once the validator is explicitly overridden — proves the override is load-bearing", async () => {
    const result = await executePostgresHandler(
      { handlerType: "postgres", connectionString: TEST_PG, query: "SELECT 1 as one" },
      {},
      new AbortController().signal,
      undefined,
      permissive
    );
    expect(result.status).toBe("success");
  });
});

describe("executePostgresHandler — row vs. byte ceiling are independently reachable", () => {
  it("returns payload_too_large for a very wide (row-count) result set of small rows", async () => {
    const result = await executePostgresHandler(
      { handlerType: "postgres", connectionString: TEST_PG, query: "SELECT generate_series(1, 5000) as n" },
      {},
      new AbortController().signal,
      undefined,
      permissive
    );
    expect(result.status).toBe("payload_too_large");
  });

  it("returns payload_too_large for a small number of very wide (byte-count) rows", async () => {
    const result = await executePostgresHandler(
      {
        handlerType: "postgres",
        connectionString: TEST_PG,
        query: "SELECT repeat('x', 2000000) as huge_col FROM generate_series(1, 10)",
      },
      {},
      new AbortController().signal,
      undefined,
      permissive
    );
    expect(result.status).toBe("payload_too_large");
  });
});

describe("executePostgresHandler — timeout paths", () => {
  it("maps a DB-side statement_timeout cancel (57014) to status: timeout", async () => {
    const result = await executePostgresHandler(
      { handlerType: "postgres", connectionString: TEST_PG, query: "SELECT pg_sleep(35)" },
      {},
      new AbortController().signal, // never aborted by the test — proves the DB-side backstop alone is sufficient
      undefined,
      permissive
    );
    expect(result.status).toBe("timeout");
  }, 40_000);

  it("force-terminates the socket on abort rather than waiting for a graceful client.end()", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const start = Date.now();
    const result = await executePostgresHandler(
      { handlerType: "postgres", connectionString: TEST_PG, query: "SELECT pg_sleep(10)" },
      {},
      controller.signal,
      undefined,
      permissive
    );
    expect(result.status).toBe("timeout");
    expect(Date.now() - start).toBeLessThan(2_000); // not anywhere near the full pg_sleep(10)
  });
});

describe("executePostgresHandler — redaction at the handler boundary", () => {
  it("never returns the raw connection string with embedded credentials in an error message", async () => {
    const badUrl = "postgresql://svc_user:sup3rSecretValue@127.0.0.1:1/doesnotexist";
    const result = await executePostgresHandler(
      { handlerType: "postgres", connectionString: badUrl, query: "SELECT 1" },
      {},
      new AbortController().signal,
      undefined,
      permissive
    );
    expect(result.status).toBe("error");
    expect(result.error).not.toContain("sup3rSecretValue");
  });
});