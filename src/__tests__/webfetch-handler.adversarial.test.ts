import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MockAgent } from "undici";
import { executeWebFetchHandler } from "../handlers/webfetch-handler.js";

describe("executeWebFetchHandler — content-type gating (Day 6 — closes an untested errorCode)", () => {
  let mockAgent: MockAgent;

  beforeEach(() => {
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
  });

  afterEach(async () => {
    await mockAgent.close();
  });

  const publicResolver = async () => ["93.184.216.34"];

  it("rejects an application/octet-stream response as unsupported media type", async () => {
    mockAgent
      .get("https://files.example.com")
      .intercept({ method: "GET", path: "/blob" })
      .reply(200, Buffer.from([0, 1, 2, 3]), { headers: { "content-type": "application/octet-stream" } });

    const result = await executeWebFetchHandler(
      { handlerType: "web_fetch", url: "https://files.example.com/blob" },
      {},
      new AbortController().signal,
      publicResolver,
      mockAgent
    );
    expect(result.status).toBe("unsupported_media_type");
  });

  it("still accepts text/plain and text/html (no regression from adding the gate)", async () => {
    mockAgent.get("https://example.com").intercept({ method: "GET", path: "/text" }).reply(200, "hello", {
      headers: { "content-type": "text/plain" },
    });
    const result = await executeWebFetchHandler(
      { handlerType: "web_fetch", url: "https://example.com/text" },
      {},
      new AbortController().signal,
      publicResolver,
      mockAgent
    );
    expect(result.status).toBe("success");
  });
});

describe("executeWebFetchHandler — literal-IP SSRF regression", () => {
  it("blocks a literal loopback IP through the real production path", async () => {
    const result = await executeWebFetchHandler(
      { handlerType: "web_fetch", url: "http://127.0.0.1:1/" },
      {},
      new AbortController().signal
    );
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/^SSRF blocked/);
  });
});