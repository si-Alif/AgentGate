import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { MockAgent } from "undici";
import { executeWebFetchHandler } from "../handlers/webfetch-handler.js";

describe("executeWebFetchHandler", () => {
  let mockAgent: MockAgent;

  beforeEach(() => {
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
  });

  afterEach(async () => {
    await mockAgent.close();
  });

  // MockAgent fakes the SOCKET, not DNS — the mandatory
  // assertSafeUrlHost() preflight still runs a real resolver unless a
  // fake one is injected. Every hostname-based test supplies BOTH a
  // resolver returning a safe public IP AND the mockAgent dispatcher.
  const publicResolver = async () => ["93.184.216.34"];

  it("accepts text/html and strips it", async () => {
    mockAgent
      .get("https://example.com")
      .intercept({ method: "GET", path: "/page" })
      .reply(200, "<html><body><h1>Hello</h1></body></html>", {
        headers: { "content-type": "text/html; charset=utf-8" },
      });

    const result = await executeWebFetchHandler(
      { handlerType: "web_fetch", url: "https://example.com/page" },
      {},
      new AbortController().signal,
      publicResolver,
      mockAgent
    );

    expect(result.status).toBe("success");
    expect((result.result as any).text).toBe("Hello");
    expect((result.result as any).contentType).toBe("text/html");
  });

  it("accepts application/json and passes it through as raw text (not parsed)", async () => {
    mockAgent
      .get("https://example.com")
      .intercept({ method: "GET", path: "/data.json" })
      .reply(200, '{"a":1}', { headers: { "content-type": "application/json" } });

    const result = await executeWebFetchHandler(
      { handlerType: "web_fetch", url: "https://example.com/data.json" },
      {},
      new AbortController().signal,
      publicResolver,
      mockAgent
    );

    expect(result.status).toBe("success");
    expect((result.result as any).text).toBe('{"a":1}');
  });

  it("rejects a binary content type via the media-type gate", async () => {
    mockAgent
      .get("https://example.com")
      .intercept({ method: "GET", path: "/image.png" })
      .reply(200, Buffer.from([0x89, 0x50, 0x4e, 0x47]), { headers: { "content-type": "image/png" } });

    const result = await executeWebFetchHandler(
      { handlerType: "web_fetch", url: "https://example.com/image.png" },
      {},
      new AbortController().signal,
      publicResolver,
      mockAgent
    );

    expect(result.status).toBe("unsupported_media_type");
    expect((result as any).result).toBeUndefined();
  });

  it("rejects a missing Content-Type header — fail-closed default", async () => {
    mockAgent
      .get("https://example.com")
      .intercept({ method: "GET", path: "/no-header" })
      .reply(200, "some body", {});

    const result = await executeWebFetchHandler(
      { handlerType: "web_fetch", url: "https://example.com/no-header" },
      {},
      new AbortController().signal,
      publicResolver,
      mockAgent
    );

    expect(result.status).toBe("unsupported_media_type");
  });

  it("rejects via Content-Length precheck before streaming, for a declared-oversized body", async () => {
    mockAgent
      .get("https://big.example.com")
      .intercept({ method: "GET", path: "/huge" })
      .reply(200, "x".repeat(100), {
        headers: { "content-type": "text/plain", "content-length": String(3 * 1024 * 1024) },
      });

    const result = await executeWebFetchHandler(
      { handlerType: "web_fetch", url: "https://big.example.com/huge" },
      {},
      new AbortController().signal,
      publicResolver,
      mockAgent
    );

    expect(result.status).toBe("payload_too_large");
  });

  it("catches an oversized body via readBoundedStream when Content-Length is missing (wiring only)", async () => {
    mockAgent
      .get("https://big2.example.com")
      .intercept({ method: "GET", path: "/huge-no-header" })
      .reply(200, "x".repeat(3 * 1024 * 1024), { headers: { "content-type": "text/plain" } });

    const result = await executeWebFetchHandler(
      { handlerType: "web_fetch", url: "https://big2.example.com/huge-no-header" },
      {},
      new AbortController().signal,
      publicResolver,
      mockAgent
    );

    expect(result.status).toBe("payload_too_large");
  });

  it("does not follow a redirect (WebFetch-local regression of Day 2's property)", async () => {
    mockAgent
      .get("https://redirect.example.com")
      .intercept({ method: "GET", path: "/start" })
      .reply(302, "", { headers: { location: "http://169.254.169.254/latest/meta-data/" } });
    // No interceptor registered for the metadata IP — if undici ever
    // auto-followed, this call would throw "no matching interceptor."

    await expect(
      executeWebFetchHandler(
        { handlerType: "web_fetch", url: "https://redirect.example.com/start" },
        {},
        new AbortController().signal,
        publicResolver,
        mockAgent
      )
    ).resolves.toBeDefined(); // resolves cleanly rather than throwing on an unmatched interceptor
  });

  it("blocks a literal loopback target via the real production default", async () => {
    const result = await executeWebFetchHandler(
      { handlerType: "web_fetch", url: "http://127.0.0.1:1/" },
      {},
      new AbortController().signal
      // no overrides — real defaultDnsResolver + real getSafeAgent()
    );

    expect(result.status).toBe("error");
    expect(result.error).toMatch(/SSRF blocked/);
  });

  it("never calls .close() on the injected dispatcher", async () => {
    const closeSpy = vi.spyOn(mockAgent, "close");
    mockAgent
      .get("https://example.com")
      .intercept({ method: "GET", path: "/ping" })
      .reply(200, "pong", { headers: { "content-type": "text/plain" } });

    await executeWebFetchHandler(
      { handlerType: "web_fetch", url: "https://example.com/ping" },
      {},
      new AbortController().signal,
      publicResolver,
      mockAgent
    );

    expect(closeSpy).not.toHaveBeenCalled(); // afterEach's own close() is separate
  });
});