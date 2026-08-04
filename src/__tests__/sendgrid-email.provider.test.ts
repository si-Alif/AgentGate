import { describe, it, expect, vi, afterEach } from "vitest";
import * as undici from "undici";
import { SendGridEmailProvider } from "../lib/email/providers/sendgrid-email.provider.js";
import { PermanentEmailError, TransientEmailError } from "../lib/email/email-provider.js";
import { env } from "../config/env.js";

vi.mock("undici", async (importOriginal) => {
  const actual = await importOriginal<typeof import("undici")>();
  return {
    ...actual,
    request: vi.fn(),
  };
});

const mockRequest = vi.mocked(undici.request);

describe("SendGridEmailProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves on a 2xx", async () => {
    (env as any).AGENTGATE_SENDGRID_API_KEY = "test-key";
    mockRequest.mockResolvedValueOnce({
      statusCode: 202,
      headers: { "x-message-id": "msg-123" },
      body: { dump: vi.fn().mockResolvedValue(undefined) },
    } as any);

    const result = await new SendGridEmailProvider().send({ to: "a@b.com", subject: "s", html: "h", text: "t" });
    expect(result).toEqual({ provider: "sendgrid", messageId: "msg-123" });
  });

  it("GATE — a 4xx throws PermanentEmailError", async () => {
    (env as any).AGENTGATE_SENDGRID_API_KEY = "test-key";
    mockRequest.mockResolvedValueOnce({
      statusCode: 400,
      headers: {},
      body: { text: vi.fn().mockResolvedValue("bad recipient") },
    } as any);

    await expect(new SendGridEmailProvider().send({ to: "bad", subject: "s", html: "h", text: "t" }))
      .rejects.toThrow(PermanentEmailError);
  });

  it("GATE — a 5xx throws TransientEmailError", async () => {
    (env as any).AGENTGATE_SENDGRID_API_KEY = "test-key";
    mockRequest.mockResolvedValueOnce({
      statusCode: 503,
      headers: {},
      body: { text: vi.fn().mockResolvedValue("unavailable") },
    } as any);

    await expect(new SendGridEmailProvider().send({ to: "a@b.com", subject: "s", html: "h", text: "t" }))
      .rejects.toThrow(TransientEmailError);
  });

  it("GATE — a network-level failure throws TransientEmailError", async () => {
    (env as any).AGENTGATE_SENDGRID_API_KEY = "test-key";
    mockRequest.mockRejectedValueOnce(new Error("ECONNRESET"));

    await expect(new SendGridEmailProvider().send({ to: "a@b.com", subject: "s", html: "h", text: "t" }))
      .rejects.toThrow(TransientEmailError);
  });
});