import { request } from "undici";
import type { Dispatcher } from "undici";
import { getSafeAgent } from "../lib/safe-agent.js";
import { assertSafeUrlHost, defaultDnsResolver, type DnsResolver } from "../lib/dns-security.js";
import { readBoundedStream } from "../lib/stream-utils.js";
import { parseMediaType, assertSupportedMediaType, extractReadableText } from "../lib/content-utils.js";
import type { HandlerResult, HandlerStatus } from "./types.js";
import {
  MAX_WEBFETCH_BYTES,
  TimeoutError,
  PayloadTooLargeError,
  SsrfBlockedError,
  UnsupportedMediaTypeError,
} from "./types.js";
import type { WebFetchHandlerConfig } from "../lib/handler-config.schema.js";

function normalizeHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export async function executeWebFetchHandler(
  config: WebFetchHandlerConfig,
  _inputParams: Record<string, unknown>,
  signal: AbortSignal,
  resolver: DnsResolver = defaultDnsResolver,
  dispatcher: Dispatcher = getSafeAgent()
): Promise<HandlerResult> {
  try {
    const targetUrl = new URL(config.url);

    await assertSafeUrlHost({ hostname: targetUrl.hostname, signal }, resolver);

    const { statusCode, headers, body: responseBody } = await request(config.url, {
      method: "GET",
      dispatcher,
      signal,
    });

    const mediaType = parseMediaType(normalizeHeader(headers["content-type"]));
    try {
      assertSupportedMediaType(mediaType);
    } catch (mediaErr) {
      responseBody.destroy();
      throw mediaErr;
    }

    // ── Content-Length precheck — same pattern as http-handler.ts ──
    const contentLengthHeader = normalizeHeader(headers["content-length"]);
    if (contentLengthHeader) {
      const contentLength = parseInt(contentLengthHeader, 10);
      if (!isNaN(contentLength) && contentLength > MAX_WEBFETCH_BYTES) {
        responseBody.destroy();
        throw new PayloadTooLargeError(contentLength, MAX_WEBFETCH_BYTES);
      }
    }

    const { buffer, totalBytes } = await readBoundedStream(responseBody, MAX_WEBFETCH_BYTES, signal);
    const raw = buffer.toString("utf-8");

    const text = extractReadableText(raw, mediaType as string);

    return {
      status: "success" as HandlerStatus,
      result: { statusCode, text, contentType: mediaType, contentLength: totalBytes },
    };
  } catch (err: any) {
    if (err.name === "AbortError" || err instanceof TimeoutError) {
      return { status: "timeout", error: "WebFetch request timed out" };
    }
    if (err instanceof PayloadTooLargeError) {
      return { status: "payload_too_large", error: err.message };
    }
    if (err instanceof UnsupportedMediaTypeError) {
      return { status: "unsupported_media_type", error: err.message };
    }
    if (err instanceof SsrfBlockedError) {
      return { status: "ssrf_blocked", error: err.message };
    }
    return { status: "error", error: err.message ?? "Unknown WebFetch handler error" };
  }
}
