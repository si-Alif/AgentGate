import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MockAgent } from "undici";
import { executeHttpHandler } from "../handlers/http-handler.js";

describe("executeHttpHandler — literal-IP SSRF regression (Day 6, THE critical retest)", () => {
  it("blocks a literal loopback target through the real production path (no dispatcher override)", async () => {
    const result = await executeHttpHandler(
      { handlerType: "http", url: "http://127.0.0.1:1/anything", method: "GET" },
      {},
      new AbortController().signal
    );
    expect(result.status).toBe("ssrf_blocked");
    expect(result.error).toMatch(/^SSRF blocked/);
  });

  it("blocks the literal cloud-metadata IP the same way", async () => {
    const result = await executeHttpHandler(
      { handlerType: "http", url: "http://169.254.169.254/latest/meta-data/", method: "GET" },
      {},
      new AbortController().signal
    );
    expect(result.status).toBe("ssrf_blocked");
    expect(result.error).toMatch(/^SSRF blocked/);
  });
});

describe("executeHttpHandler — redirect non-following (retained, re-verified)", () => {
  let mockAgent: MockAgent;
  beforeEach(() => { mockAgent = new MockAgent(); mockAgent.disableNetConnect(); });
  afterEach(async () => { await mockAgent.close(); });

  const publicResolver = async () => ["93.184.216.34"];

  it("returns a 3xx as-is; never auto-follows toward an internal target", async () => {
    mockAgent
      .get("https://redirector.example.com")
      .intercept({ method: "GET", path: "/go" })
      .reply(302, "", { headers: { location: "http://169.254.169.254/latest/meta-data/" } });
    // No interceptor exists for the metadata host. If undici ever
    // auto-followed, MockAgent throws "no matching interceptor"
    // instead of returning the 302 below — that's what makes this a
    // meaningful assertion rather than a tautology.

    const result = await executeHttpHandler(
      { handlerType: "http", url: "https://redirector.example.com/go", method: "GET" },
      {},
      new AbortController().signal,
      publicResolver,
      mockAgent
    );
    expect(result.status).toBe("success");
    expect((result.result as any).statusCode).toBe(302);
  });
});

describe("executeHttpHandler — dispatcher-injection contract confirmation", () => {
  it("an explicitly injected dispatcher is actually consulted", async () => {
    const mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    mockAgent.get("https://api.example.com").intercept({ method: "GET", path: "/ping" }).reply(200, { pong: true });

    const publicResolver = async () => ["93.184.216.34"];

    const result = await executeHttpHandler(
      { handlerType: "http", url: "https://api.example.com/ping", method: "GET" },
      {},
      new AbortController().signal,
      publicResolver,
      mockAgent
    );
    expect(result.status).toBe("success");
    await mockAgent.close();
  });
});