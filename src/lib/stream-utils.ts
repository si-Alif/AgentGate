import { PayloadTooLargeError, TimeoutError } from "../handlers/types.js";

export interface DestroyableAsyncByteStream extends AsyncIterable<Uint8Array> {
  destroy: (err?: Error) => void;
  destroyed: boolean;
}

export interface BoundedStreamResult {
  buffer: Buffer;
  totalBytes: number;
}

export async function readBoundedStream(
  stream : DestroyableAsyncByteStream,
  maxBytes : number,
  signal : AbortSignal
) : Promise<BoundedStreamResult> {
  const chunks : Buffer[] = [];
  let totalBytes = 0;

  try {
    for await (const chunk of stream) {
      if (signal.aborted) {
        stream.destroy();
        throw new TimeoutError("Stream reading aborted");
      }

      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buf.length;

      if (totalBytes > maxBytes) {
        stream.destroy();
        throw new PayloadTooLargeError(totalBytes, maxBytes);
      }
      chunks.push(buf);
    }
    return {
      buffer: Buffer.concat(chunks),
      totalBytes
    };
  }finally{
    if(!stream.destroyed) stream.destroy();
  }

}