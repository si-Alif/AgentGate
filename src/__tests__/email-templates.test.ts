import { describe, it, expect } from "vitest";
import { renderVerificationEmail } from "../lib/email/email-templates.js";

describe("renderVerificationEmail", () => {
  it("builds an ABSOLUTE verification URL, never a relative path", () => {
    const rendered = renderVerificationEmail({ token: "abc123token" });
    expect(rendered.text).toMatch(/^https?:\/\//m);
  });

  it("embeds the exact token as a query parameter, in both html and text", () => {
    const rendered = renderVerificationEmail({ token: "unique-token-xyz" });
    expect(rendered.text).toContain("token=unique-token-xyz");
    expect(rendered.html).toContain("token=unique-token-xyz");
  });
});