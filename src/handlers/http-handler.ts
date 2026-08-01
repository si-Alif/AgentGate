import { request } from "undici";
import type { Dispatcher } from "undici";
import { getSafeAgent } from "../lib/safe-agent.js";
import { assertSafeUrlHost, defaultDnsResolver, type DnsResolver } from "../lib/dns-security.js";
import { readBoundedStream } from "../lib/stream-utils.js";
import type { HandlerResult, HandlerStatus } from "./types.js";
import { MAX_PAYLOAD_BYTES, TimeoutError, PayloadTooLargeError, SsrfBlockedError } from "./types.js";
import type { HttpHandlerConfig } from "../lib/handler-config.schema.js";

function escapeForJsonStringContext(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

function interpolateBody(template: string, params: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    const value = params[key];
    if (value === undefined) return match;
    if (typeof value === "string") return escapeForJsonStringContext(value);
    return JSON.stringify(value);
  });
}

type UndiciRequestOptions = NonNullable<Parameters<typeof request>[1]>;

export function buildHttpRequestOptions(
  config: HttpHandlerConfig,
  inputParams: Record<string, unknown>,
  dispatcher: Dispatcher,
  signal: AbortSignal
): { url: string; options: UndiciRequestOptions } {
  let body: string | undefined;
  if (config.bodyTemplate) {
    body = interpolateBody(config.bodyTemplate, inputParams);
  }

  const options: UndiciRequestOptions = {
    method: config.method,
    dispatcher,
    signal,
  };

  if (config.headers !== undefined) options.headers = config.headers;
  if (body !== undefined) options.body = body;

  return { url: config.url, options };
}

export async function executeHttpHandler(
  config: HttpHandlerConfig,
  inputParams: Record<string, unknown>,
  signal: AbortSignal,
  resolver: DnsResolver = defaultDnsResolver,
  dispatcher: Dispatcher = getSafeAgent()
): Promise<HandlerResult> {
  try {
    const targetUrl = new URL(config.url);

    // FIXED: assertSafeUrlHost takes a single ResolveRequest object,
    // not (hostname, resolver, signal) positionally. The returned
    // ResolvedTarget is intentionally unused here — this call exists
    // to fail fast and to catch literal-IP hosts, which the Agent's
    // own connect-time lookup hook (safe-lookup.ts) structurally
    // cannot check (nothing to look up for an already-literal IP).
    await assertSafeUrlHost({ hostname: targetUrl.hostname, signal }, resolver);

    const { url, options } = buildHttpRequestOptions(config, inputParams, dispatcher, signal);
    const { statusCode, headers, body: responseBody } = await request(url, options);

    const contentLengthHeader = headers["content-length"];
    if (contentLengthHeader) {
      const contentLength = parseInt(
        Array.isArray(contentLengthHeader) ? (contentLengthHeader[0] ?? "") : contentLengthHeader,
        10
      );
      if (!isNaN(contentLength) && contentLength > MAX_PAYLOAD_BYTES) {
        responseBody.destroy();
        throw new PayloadTooLargeError(contentLength, MAX_PAYLOAD_BYTES);
      }
    }

    const { buffer } = await readBoundedStream(responseBody, MAX_PAYLOAD_BYTES, signal);
    const text = buffer.toString("utf-8");

    let result: unknown = text;
    const contentType = headers["content-type"];
    const contentTypeValue = Array.isArray(contentType) ? contentType[0] : contentType;
    if (contentTypeValue?.includes("application/json")) {
      try {
        result = JSON.parse(text);
      } catch {
        // Not valid JSON — fall back to raw text.
      }
    }

    return {
      status: "success" as HandlerStatus,
      result: { statusCode, headers: headers as Record<string, unknown>, body: result },
    };
  } catch (err: any) {
    if (err.name === "AbortError" || err instanceof TimeoutError) {
      return { status: "timeout", error: "HTTP request timed out" };
    }
    if (err instanceof PayloadTooLargeError) {
      return { status: "payload_too_large", error: err.message };
    }
    if (err instanceof SsrfBlockedError || err.name === "SsrfBlockedError") {
      return {
        status: "ssrf_blocked",
        error: err.message
      };
    }
    return { status: "error", error: err.message ?? "Unknown HTTP handler error" };
  }
}