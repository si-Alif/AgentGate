import { describe, it, expect, vi } from "vitest";
import { Agent, MockAgent, request, setGlobalDispatcher } from "undici";
import { executeHttpHandler, buildHttpRequestOptions } from "../handlers/http-handler.js";
import { createSafeLookup } from "../lib/safe-lookup.js";
import type { DnsResolver } from "../lib/dns-security.js";
import type { HttpHandlerConfig } from "../lib/handler-config.schema.js";
import { MAX_PAYLOAD_BYTES } from "../handlers/types.js";

const SAFE_IP = "93.184.216.34"; // example.com's real IP — arbitrary "safe" stand-in
const UNSAFE_IP = "169.254.169.254"; // cloud metadata — always blocked by Layer 1

function baseConfig(overrides: Partial<HttpHandlerConfig> = {}): HttpHandlerConfig {
  return {
    handlerType: "http",
    url: "https://external-api.example.com/status",
    method: "GET",
    ...overrides,
  } as HttpHandlerConfig;
}

// ═══════════════════════════════════════════════════════════════════
// 1. Regression guard — the bug this whole handler shape exists to fix
// ═══════════════════════════════════════════════════════════════════
describe("Regression: undici's explicit `dispatcher` option wins over setGlobalDispatcher", () => {
  it("proves why executeHttpHandler MUST accept an injectable dispatcher param", async () => {
    const globalMock = new MockAgent();
    globalMock.disableNetConnect();
    globalMock.get("https://test.example").intercept({ path: "/foo", method: "GET" }).reply(200, "FROM GLOBAL");
    setGlobalDispatcher(globalMock);

    const explicitMock = new MockAgent();
    explicitMock.disableNetConnect();
    explicitMock.get("https://test.example").intercept({ path: "/foo", method: "GET" }).reply(200, "FROM EXPLICIT");

    const r1 = await request("https://test.example/foo", { method: "GET" });
    expect(await r1.body.text()).toBe("FROM GLOBAL");

    const r2 = await request("https://test.example/foo", { method: "GET", dispatcher: explicitMock });
    expect(await r2.body.text()).toBe("FROM EXPLICIT");
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. buildHttpRequestOptions — pure, no network
// ═══════════════════════════════════════════════════════════════════
describe("buildHttpRequestOptions", () => {
  it("omits `body` entirely when no bodyTemplate is configured (GET path)", () => {
    const { options } = buildHttpRequestOptions(baseConfig(), {}, new MockAgent(), new AbortController().signal);
    expect("body" in options).toBe(false);
  });

  it("omits `headers` entirely when config.headers is undefined (exactOptionalPropertyTypes correctness)", () => {
    const { options } = buildHttpRequestOptions(baseConfig(), {}, new MockAgent(), new AbortController().signal);
    expect("headers" in options).toBe(false);
  });

  it("includes headers when configured", () => {
    const { options } = buildHttpRequestOptions(
      baseConfig({ headers: { "x-api-key": "abc123" } }),
      {},
      new MockAgent(),
      new AbortController().signal
    );
    expect(options.headers).toEqual({ "x-api-key": "abc123" });
  });

  it("leaves an unmatched placeholder untouched when the param is missing", () => {
    const { options } = buildHttpRequestOptions(
      baseConfig({ method: "POST", bodyTemplate: '{"name":"{{name}}","extra":"{{missing}}"}' }),
      { name: "alice" },
      new MockAgent(),
      new AbortController().signal
    );
    expect(options.body).toBe('{"name":"alice","extra":"{{missing}}"}');
  });

  it("JSON.stringifies non-string values without re-quoting them", () => {
    const { options } = buildHttpRequestOptions(
      baseConfig({ method: "POST", bodyTemplate: '{"count":{{count}},"active":{{active}}}' }),
      { count: 42, active: true },
      new MockAgent(),
      new AbortController().signal
    );
    expect(options.body).toBe('{"count":42,"active":true}');
  });

  it("escapes an attacker-controlled quote instead of letting it break the JSON structure", () => {
    const { options } = buildHttpRequestOptions(
      baseConfig({ method: "POST", bodyTemplate: '{"name": "{{name}}"}' }),
      { name: 'x", "isAdmin": "true' },
      new MockAgent(),
      new AbortController().signal
    );
    const parsed = JSON.parse(options.body as string);
    expect(Object.keys(parsed)).toEqual(["name"]);
    expect(parsed.name).toBe('x", "isAdmin": "true');
  });

  it("escapes an attacker-controlled backslash (not just quotes)", () => {
    const { options } = buildHttpRequestOptions(
      baseConfig({ method: "POST", bodyTemplate: '{"path": "{{path}}"}' }),
      { path: "C:\\Windows\\System32" },
      new MockAgent(),
      new AbortController().signal
    );
    const parsed = JSON.parse(options.body as string);
    expect(parsed.path).toBe("C:\\Windows\\System32");
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. SSRF — pre-flight enforcement (literal-IP class)
// ═══════════════════════════════════════════════════════════════════
describe("executeHttpHandler — SSRF pre-flight enforcement", () => {
  it("blocks a literal loopback IP and never invokes the DNS resolver", async () => {
    const resolverSpy = vi.fn();
    const config = baseConfig({ url: "http://127.0.0.1:9999/anything" });
    const result = await executeHttpHandler(config, {}, new AbortController().signal, resolverSpy);

    // CHANGE THIS:
    expect(result.status).toBe("ssrf_blocked");

    expect(result.error).toMatch(/^SSRF blocked/i); // (Optional: Add 'i' flag for case-insensitivity just in case)
    expect(resolverSpy).not.toHaveBeenCalled();
  });

  it("blocks the literal cloud metadata IP and never invokes the DNS resolver", async () => {
    const resolverSpy = vi.fn();
    const config = baseConfig({ url: `http://${UNSAFE_IP}/latest/meta-data/` });
    const result = await executeHttpHandler(config, {}, new AbortController().signal, resolverSpy);

    // CHANGE THIS:
    expect(result.status).toBe("ssrf_blocked");

    expect(result.error).toMatch(/^SSRF blocked/i);
    expect(resolverSpy).not.toHaveBeenCalled();
  });

  it("blocks a bracketed IPv6 loopback literal ([::1]) — proves bracket-stripping works", async () => {
    const resolverSpy = vi.fn();
    const config = baseConfig({ url: "http://[::1]:9999/anything" });
    const result = await executeHttpHandler(config, {}, new AbortController().signal, resolverSpy);

    // CHANGE THIS:
    expect(result.status).toBe("ssrf_blocked");

    expect(result.error).toMatch(/^SSRF blocked/i);
    expect(resolverSpy).not.toHaveBeenCalled();
  });

  it("blocks an IPv4-mapped IPv6 literal (::ffff:169.254.169.254)", async () => {
    const resolverSpy = vi.fn();
    const config = baseConfig({ url: "http://[::ffff:169.254.169.254]/x" });
    const result = await executeHttpHandler(config, {}, new AbortController().signal, resolverSpy);

    // CHANGE THIS:
    expect(result.status).toBe("ssrf_blocked");

    expect(resolverSpy).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════
// 4. SSRF — connect-time hook & DNS rebinding (the gap flagged in review)
// ═══════════════════════════════════════════════════════════════════
describe("executeHttpHandler — connect-time lookup hook (defense-in-depth, not just pre-flight)", () => {
  it("blocks a hostname whose pre-flight resolution is safe but whose CONNECT-TIME resolution is not", async () => {
    // This is the rebinding window Layer 2 exists to close: the two
    // resolutions here are deliberately DIFFERENT functions returning
    // DIFFERENT IPs. If this test only used one shared resolver, it
    // would never prove the connect-time hook is independently
    // authoritative — it would only prove the pre-flight check works
    // (already covered above).
    const preflightResolver: DnsResolver = async () => [SAFE_IP];
    const connectTimeResolver: DnsResolver = async () => [UNSAFE_IP];

    const reboundAgent = new Agent({
      connect: {
        lookup: createSafeLookup(connectTimeResolver),
        timeout: 2000, // fail fast if this ever falls through to a real connect attempt
      },
    });

    const config = baseConfig({ url: "https://rebinding-target.example.com/status" });
    const result = await executeHttpHandler(
      config,
      {},
      new AbortController().signal,
      preflightResolver,
      reboundAgent
    );

    expect(result.status).toBe("ssrf_blocked");

    expect(result.error).toMatch(/ssrf blocked/i);
  });

  it("succeeds when BOTH pre-flight and connect-time resolvers agree the target is safe", async () => {
    const agreedResolver: DnsResolver = async () => [SAFE_IP];
    const consistentAgent = new Agent({
      connect: { lookup: createSafeLookup(agreedResolver), timeout: 2000 },
    });

    // No MockAgent here — this is a REAL connection attempt to the
    // real example.com IP over a real Agent, proving the safe-lookup
    // wiring doesn't itself break legitimate traffic. Network access
    // required for this one test; skip/mark integration-only if your
    // CI runs offline.
    const config = baseConfig({ url: "https://example.com/" });
    const result = await executeHttpHandler(
      config,
      {},
      AbortSignal.timeout(5000),
      agreedResolver,
      consistentAgent
    );
    expect(["success", "error"]).toContain(result.status); // real network flake-tolerant
    if (result.status === "error") {
      expect(result.error).not.toMatch(/ssrf/i); // whatever failed, it wasn't the safety layer
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// 5. Hermetic success paths — all via injected MockAgent, zero real network
// ═══════════════════════════════════════════════════════════════════
describe("executeHttpHandler — success paths (MockAgent, no real network)", () => {
  const fakeResolver: DnsResolver = async () => [SAFE_IP];

  it("succeeds with a JSON response", async () => {
    const mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    mockAgent
      .get("https://external-api.example.com")
      .intercept({ path: "/status", method: "GET" })
      .reply(200, JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });

    const result = await executeHttpHandler(baseConfig(), {}, new AbortController().signal, fakeResolver, mockAgent);
    expect(result.status).toBe("success");
    expect((result.result as any).body).toEqual({ ok: true });
  });

  it("returns raw text when content-type is not JSON", async () => {
    const mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    mockAgent
      .get("https://external-api.example.com")
      .intercept({ path: "/status", method: "GET" })
      .reply(200, "plain text response", { headers: { "content-type": "text/plain" } });

    const result = await executeHttpHandler(baseConfig(), {}, new AbortController().signal, fakeResolver, mockAgent);
    expect(result.status).toBe("success");
    expect((result.result as any).body).toBe("plain text response");
  });

  it("falls back to raw text when content-type claims JSON but the body isn't valid JSON", async () => {
    const mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    mockAgent
      .get("https://external-api.example.com")
      .intercept({ path: "/status", method: "GET" })
      .reply(200, "{not: valid json", { headers: { "content-type": "application/json" } });

    const result = await executeHttpHandler(baseConfig(), {}, new AbortController().signal, fakeResolver, mockAgent);
    expect(result.status).toBe("success"); // must NOT throw on JSON.parse failure
    expect((result.result as any).body).toBe("{not: valid json");
  });

  it("sends configured custom headers through to the upstream request", async () => {
    const mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    mockAgent
      .get("https://external-api.example.com")
      .intercept({
        path: "/status",
        method: "GET",
        headers: { "x-tenant-key": "tenant-abc" },
      })
      .reply(200, "ok");

    const config = baseConfig({ headers: { "x-tenant-key": "tenant-abc" } });
    const result = await executeHttpHandler(config, {}, new AbortController().signal, fakeResolver, mockAgent);
    expect(result.status).toBe("success");
  });

  it("interpolates the body template and sends the resulting JSON on a POST", async () => {
    const mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    mockAgent
      .get("https://external-api.example.com")
      .intercept({
        path: "/webhook",
        method: "POST",
        body: '{"event": "tool_invoked", "user": "alif"}',
      })
      .reply(200, "received");

    const config = baseConfig({
      url: "https://external-api.example.com/webhook",
      method: "POST",
      bodyTemplate: '{"event": "{{event}}", "user": "{{user}}"}',
    });
    const result = await executeHttpHandler(
      config,
      { event: "tool_invoked", user: "alif" },
      new AbortController().signal,
      fakeResolver,
      mockAgent
    );
    expect(result.status).toBe("success");
  });

  it("returns a 302 pointing at an internal IP as-is, never follows it", async () => {
    const mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    mockAgent
      .get("https://external-api.example.com")
      .intercept({ path: "/redirect-me", method: "GET" })
      .reply(302, "", { headers: { location: `http://${UNSAFE_IP}/internal` } });

    const config = baseConfig({ url: "https://external-api.example.com/redirect-me" });
    const result = await executeHttpHandler(config, {}, new AbortController().signal, fakeResolver, mockAgent);
    expect(result.status).toBe("success");
    expect((result.result as any).statusCode).toBe(302);
  });

  it.each(["PUT", "PATCH", "DELETE"] as const)("supports %s as a method", async (method) => {
    const mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    mockAgent
      .get("https://external-api.example.com")
      .intercept({ path: "/resource/1", method })
      .reply(200, "ok");

    const config = baseConfig({ url: "https://external-api.example.com/resource/1", method });
    const result = await executeHttpHandler(config, {}, new AbortController().signal, fakeResolver, mockAgent);
    expect(result.status).toBe("success");
  });
});

// ═══════════════════════════════════════════════════════════════════
// 6. Payload ceiling
// ═══════════════════════════════════════════════════════════════════
describe("executeHttpHandler — payload ceiling", () => {
  const fakeResolver: DnsResolver = async () => [SAFE_IP];

  it("rejects before streaming when the DECLARED Content-Length exceeds the ceiling", async () => {
    const mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    mockAgent
      .get("https://external-api.example.com")
      .intercept({ path: "/huge", method: "GET" })
      .reply(200, "tiny actual body", {
        headers: { "content-length": String(MAX_PAYLOAD_BYTES + 1) },
      });

    const config = baseConfig({ url: "https://external-api.example.com/huge" });
    const result = await executeHttpHandler(config, {}, new AbortController().signal, fakeResolver, mockAgent);
    expect(result.status).toBe("payload_too_large");
  });

  it("rejects an actually-oversized body even when framed without a reliable declared length", async () => {
    // NOTE: depending on your pinned undici version, MockAgent may
    // auto-compute an accurate content-length for a Buffer body, in
    // which case this trips the header precheck above rather than
    // readBoundedStream's byte counter. Either enforcement point
    // firing satisfies the actual security property under test
    // (nothing over the ceiling gets through) — verify empirically
    // against undici@8.8.0 which mechanism fires, same discipline as
    // Day 2's own dispatcher-override finding.
    const oversized = Buffer.alloc(MAX_PAYLOAD_BYTES + 1024, "a");
    const mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    mockAgent
      .get("https://external-api.example.com")
      .intercept({ path: "/stream-oversized", method: "GET" })
      .reply(200, oversized);

    const config = baseConfig({ url: "https://external-api.example.com/stream-oversized" });
    const result = await executeHttpHandler(config, {}, new AbortController().signal, fakeResolver, mockAgent);
    expect(result.status).toBe("payload_too_large");
  });

  it("accepts a response of exactly MAX_PAYLOAD_BYTES (boundary is inclusive, not exclusive)", async () => {
    const exact = Buffer.alloc(MAX_PAYLOAD_BYTES, "a");
    const mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    mockAgent
      .get("https://external-api.example.com")
      .intercept({ path: "/exact", method: "GET" })
      .reply(200, exact);

    const config = baseConfig({ url: "https://external-api.example.com/exact" });
    const result = await executeHttpHandler(config, {}, new AbortController().signal, fakeResolver, mockAgent);
    expect(result.status).toBe("success");
  });
});

// ═══════════════════════════════════════════════════════════════════
// 7. Timeout / abort handling
// ═══════════════════════════════════════════════════════════════════
describe("executeHttpHandler — timeout and abort handling", () => {
  const fakeResolver: DnsResolver = async () => [SAFE_IP];

  it("returns status:'timeout' immediately if the signal is already aborted, without attempting the request", async () => {
    const mockAgent = new MockAgent();
    mockAgent.disableNetConnect(); // if this trips, a real/mock call was attempted — test should fail loudly

    const controller = new AbortController();
    controller.abort();

    const result = await executeHttpHandler(baseConfig(), {}, controller.signal, fakeResolver, mockAgent);
    expect(result.status).toBe("timeout");
  });

  it("returns status:'timeout' when the signal fires mid-request (upstream is slow)", async () => {
    const mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    mockAgent
      .get("https://external-api.example.com")
      .intercept({ path: "/slow", method: "GET" })
      .reply(200, "eventually")
      .delay(2000); // resolves long after our abort fires below

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);

    const config = baseConfig({ url: "https://external-api.example.com/slow" });
    const result = await executeHttpHandler(config, {}, controller.signal, fakeResolver, mockAgent);
    expect(result.status).toBe("timeout");
  });

  it("returns status:'timeout' (not 'error') when DNS resolution itself hangs past the caller's signal", async () => {
    const hangingResolver: DnsResolver = () => new Promise(() => { }); // never settles
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);

    const config = baseConfig({ url: "https://never-resolves.example.com/x" });
    const result = await executeHttpHandler(config, {}, controller.signal, hangingResolver);
    expect(result.status).toBe("timeout");
  });
});

// ═══════════════════════════════════════════════════════════════════
// 8. Resilience — the handler must never throw, regardless of cause
// ═══════════════════════════════════════════════════════════════════
describe("executeHttpHandler — never throws, even on unexpected failure modes", () => {
  const fakeResolver: DnsResolver = async () => [SAFE_IP];

  it("returns status:'error' for a generic upstream network failure (not SSRF, not timeout, not oversized)", async () => {
    const mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    mockAgent
      .get("https://external-api.example.com")
      .intercept({ path: "/status", method: "GET" })
      .replyWithError(new Error("simulated ECONNRESET"));

    const result = await executeHttpHandler(baseConfig(), {}, new AbortController().signal, fakeResolver, mockAgent);
    expect(result.status).toBe("error");
    expect(result.error).toBeTruthy();
  });

  it("returns status:'error' rather than throwing when config.url is malformed", async () => {
    // Schema validation (Week 2) should prevent this from ever
    // reaching the handler in production — this test exists purely
    // to prove the handler doesn't trust that upstream guarantee and
    // crash the process if a decrypted/tampered config ever slips
    // past it (defense in depth, same posture as the rest of Week 4).
    const badConfig = { handlerType: "http", url: "not a url at all", method: "GET" } as HttpHandlerConfig;
    const result = await executeHttpHandler(badConfig, {}, new AbortController().signal, fakeResolver);
    expect(result.status).toBe("error");
  });
});