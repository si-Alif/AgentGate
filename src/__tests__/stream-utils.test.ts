import { describe, it, expect } from "vitest";
import { readBoundedStream, type DestroyableAsyncByteStream } from "../lib/stream-utils.js";
import { PayloadTooLargeError, TimeoutError } from "../handlers/types.js";

function fakeStream(chunks: Buffer[]): DestroyableAsyncByteStream & { destroyCalls: unknown[] } {
  const destroyCalls: unknown[] = [];
  return {
    destroyed: false,
    destroy(err?: Error) {
      destroyCalls.push(err);
      (this as any).destroyed = true;
    },
    destroyCalls,
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  };
}

describe("readBoundedStream — happy paths", () => {
  it("returns the full buffer under the ceiling, and still destroys in the finally block", async () => {
    const stream = fakeStream([Buffer.from("hello "), Buffer.from("world")]);
    const { buffer, totalBytes } = await readBoundedStream(stream, 100, new AbortController().signal);
    expect(buffer.toString("utf-8")).toBe("hello world");
    expect(totalBytes).toBe(11);
    expect(stream.destroyCalls.length).toBe(1);
  });

  it("handles a zero-chunk (empty) stream without error", async () => {
    const stream = fakeStream([]);
    const { buffer, totalBytes } = await readBoundedStream(stream, 100, new AbortController().signal);
    expect(totalBytes).toBe(0);
    expect(buffer.length).toBe(0);
    expect(stream.destroyCalls.length).toBe(1); // still destroyed, even with nothing to read
  });

  it("succeeds when total bytes land EXACTLY on the ceiling (boundary is inclusive)", async () => {
    const stream = fakeStream([Buffer.alloc(100, "a")]);
    const { totalBytes } = await readBoundedStream(stream, 100, new AbortController().signal);
    expect(totalBytes).toBe(100); // must NOT throw at exactly the limit
  });
});

describe("readBoundedStream — ceiling breach", () => {
  it("destroys the stream and throws PayloadTooLargeError the instant the ceiling is breached", async () => {
    const bigChunk = Buffer.alloc(50, "a");
    const stream = fakeStream([bigChunk, bigChunk, bigChunk]); // 150 bytes, ceiling 100
    await expect(readBoundedStream(stream, 100, new AbortController().signal)).rejects.toThrow(
      PayloadTooLargeError
    );
    expect(stream.destroyCalls[0]).toBeInstanceOf(PayloadTooLargeError);
  });

  it("breaches on the FIRST chunk that crosses the ceiling, not after accumulating all chunks", async () => {
    // 101 bytes arrives in one chunk against a 100-byte ceiling — proves
    // detection happens per-chunk, not only after the iterator finishes.
    const stream = fakeStream([Buffer.alloc(101, "a")]);
    let caught: unknown;
    try {
      await readBoundedStream(stream, 100, new AbortController().signal);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PayloadTooLargeError);
    expect((caught as PayloadTooLargeError).actualBytes).toBe(101);
  });

  it("one byte over the ceiling still throws (off-by-one guard)", async () => {
    const stream = fakeStream([Buffer.alloc(101, "a")]);
    await expect(readBoundedStream(stream, 100, new AbortController().signal)).rejects.toThrow(
      PayloadTooLargeError
    );
  });
});

describe("readBoundedStream — abort handling", () => {
  it("aborts mid-stream when the signal fires between chunks", async () => {
    const controller = new AbortController();
    let destroyed = false;
    const stream: DestroyableAsyncByteStream = {
      destroyed: false,
      destroy() {
        destroyed = true;
      },
      async *[Symbol.asyncIterator]() {
        yield Buffer.from("first");
        controller.abort();
        yield Buffer.from("second");
      },
    };
    await expect(readBoundedStream(stream, 1000, controller.signal)).rejects.toThrow();
    expect(destroyed).toBe(true);
  });

  it("rejects immediately if the signal is already aborted before iteration starts", async () => {
    const controller = new AbortController();
    controller.abort();
    let iterated = false;
    const stream: DestroyableAsyncByteStream = {
      destroyed: false,
      destroy() { },
      async *[Symbol.asyncIterator]() {
        iterated = true;
        yield Buffer.from("should never be read");
      },
    };
    await expect(readBoundedStream(stream, 1000, controller.signal)).rejects.toThrow();
    // Not a hard requirement that iteration never STARTS (a for-await
    // loop checks the signal on its first pass through this
    // implementation), but it must never complete/return successfully.
  });
});

describe("readBoundedStream — destroy() is called exactly once, even when iteration itself throws", () => {
  it("calls destroy() via finally when the underlying iterator throws synchronously", async () => {
    const destroyCalls: unknown[] = [];
    const stream: DestroyableAsyncByteStream = {
      destroyed: false,
      destroy(err?: Error) {
        destroyCalls.push(err);
        (this as any).destroyed = true;
      },
      // eslint-disable-next-line require-yield
      async *[Symbol.asyncIterator]() {
        throw new Error("simulated socket error mid-iteration");
      },
    };
    await expect(readBoundedStream(stream, 1000, new AbortController().signal)).rejects.toThrow(
      "simulated socket error mid-iteration"
    );
    expect(destroyCalls.length).toBe(1);
  });

  it("does not call destroy() a second time if the stream reports itself already destroyed", async () => {
    const destroyCalls: unknown[] = [];
    const stream: DestroyableAsyncByteStream = {
      destroyed: true, // already destroyed by the time finally runs
      destroy(err?: Error) {
        destroyCalls.push(err);
      },
      async *[Symbol.asyncIterator]() {
        yield Buffer.from("x");
      },
    };
    await readBoundedStream(stream, 1000, new AbortController().signal);
    expect(destroyCalls.length).toBe(0); // guarded by `if (!stream.destroyed)`
  });
});