import { describe, it, expect, vi } from "vitest";
import { executePostgresStreamingQuery } from "../lib/postgres-stream.js";
import { RowLimitExceededError, ByteLimitExceededError, MAX_POSTGRES_ROWS, MAX_POSTGRES_PAYLOAD_BYTES } from "../handlers/types.js";

describe("executePostgresStreamingQuery — ceilings", () => {
  it("throws RowLimitExceededError once row count exceeds the limit", async () => {
    async function* mockStream() {
      for (let i = 0; i <= MAX_POSTGRES_ROWS; i++) yield { id: i };
    }
    const mockClient = { query: vi.fn().mockReturnValue(mockStream()) } as any;
    await expect(executePostgresStreamingQuery(mockClient, "SELECT", [])).rejects.toThrow(RowLimitExceededError);
  });

  it("throws ByteLimitExceededError once cumulative bytes exceed the limit", async () => {
    async function* mockStream() {
      yield { data: "x".repeat(MAX_POSTGRES_PAYLOAD_BYTES + 10) };
    }
    const mockClient = { query: vi.fn().mockReturnValue(mockStream()) } as any;
    await expect(executePostgresStreamingQuery(mockClient, "SELECT", [])).rejects.toThrow(ByteLimitExceededError);
  });

  it("returns all rows when under both ceilings", async () => {
    async function* mockStream() {
      yield { id: 1 };
      yield { id: 2 };
    }
    const mockClient = { query: vi.fn().mockReturnValue(mockStream()) } as any;
    const rows = await executePostgresStreamingQuery(mockClient, "SELECT", []);
    expect(rows).toEqual([{ id: 1 }, { id: 2 }]);
  });
});