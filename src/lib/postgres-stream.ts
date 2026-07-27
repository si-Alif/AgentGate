import QueryStream from "pg-query-stream";
import type { Client } from "pg";
import {
  MAX_POSTGRES_ROWS,
  MAX_POSTGRES_PAYLOAD_BYTES,
  RowLimitExceededError,
  ByteLimitExceededError,
} from "../handlers/types.js";

export async function executePostgresStreamingQuery(
  client: Client,
  query: string,
  queryParams?: unknown[]
): Promise<Record<string, unknown>[]> {
  const stream = new QueryStream(query, queryParams, {
    batchSize: 100
  })

  const asyncIterable = client.query(stream) as AsyncIterable<Record<string, unknown>>;

  const rows: Record<string, unknown>[] = [];
  let totalBytes = 0;

  for await (const row of asyncIterable) {
    if (rows.length >= MAX_POSTGRES_ROWS){
      const err = new RowLimitExceededError(rows.length + 1, MAX_POSTGRES_ROWS);
      stream.destroy(err);
      throw err;
    }
    totalBytes += Buffer.byteLength(JSON.stringify(row), "utf-8");
    if (totalBytes > MAX_POSTGRES_PAYLOAD_BYTES) {
      const err = new ByteLimitExceededError(totalBytes, MAX_POSTGRES_PAYLOAD_BYTES);
      stream.destroy(err);
      throw err;
    }
    rows.push(row);

  }

  return rows;
}