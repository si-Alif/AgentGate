import { describe, it, expect } from "vitest";
import { parsePostgresUrl, redactConnectionString } from "../lib/postgres-utils.js";

describe("parsePostgresUrl", () => {
  it("extracts all fields correctly", () => {
    const parsed = parsePostgresUrl("postgresql://user:pass@db.example.com:5433/mydb?sslmode=require");
    expect(parsed).toEqual({
      hostname: "db.example.com",
      port: 5433,
      database: "mydb",
      user: "user",
      password: "pass",
      sslMode: "require",
    });
  });

  it("defaults port to 5432 and sslMode to 'prefer' when absent", () => {
    const parsed = parsePostgresUrl("postgresql://user:pass@db.example.com/mydb");
    expect(parsed.port).toBe(5432);
    expect(parsed.sslMode).toBe("prefer");
  });
});

describe("redactConnectionString", () => {
  it("masks the password segment of a connection string", () => {
    const redacted = redactConnectionString("postgresql://user:supersecret@db.example.com:5432/mydb");
    expect(redacted).not.toContain("supersecret");
    expect(redacted).toContain("user:***@");
  });

  it("leaves strings with no embedded credentials unchanged", () => {
    expect(redactConnectionString("connection refused: db.example.com:5432")).toBe(
      "connection refused: db.example.com:5432"
    );
  });
});