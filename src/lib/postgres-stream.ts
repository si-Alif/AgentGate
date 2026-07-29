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

      // QueryStream is a Node.js Stream. When you pass an error to
      // .destroy(err), Node.js immediately emits an asynchronous 'error' event on that specific stream instance. Because there are no event listeners actively listening to stream.on('error', ...) in your code or test suite, Node.js treats it as an Unhandled Exception and bubbles it up, crashing the event loop.

      stream.destroy();
      //Meanwhile, this function also executes the synchronous `throw err;` on the next line. Vitest perfectly catches this synchronous throw (which is why your tests actually pass), but it still flags the unhandled stream emission happening in the background , resulting in the warning you see.
      // The warning is not about the synchronous throw, but about the asynchronous 'error' event that was emitted without a listener.
      throw err;
    }
    totalBytes += Buffer.byteLength(JSON.stringify(row), "utf-8");
    if (totalBytes > MAX_POSTGRES_PAYLOAD_BYTES) {
      const err = new ByteLimitExceededError(totalBytes, MAX_POSTGRES_PAYLOAD_BYTES);
      stream.destroy();
      throw err;
    }
    rows.push(row);

  }

  return rows;
}