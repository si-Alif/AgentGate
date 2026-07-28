import { describe, it, expect } from "vitest";
import { redactSecrets } from "../lib/error-redaction.js";

describe("redactSecrets", () => {
  it("masks credentials embedded in a URL", () => {
    const redacted = redactSecrets("connect failed: postgresql://svc_user:sup3rSecret@10.0.0.5:5432/prod");
    expect(redacted).not.toContain("sup3rSecret");
    expect(redacted).toContain("svc_user:***@");
  });

  it("masks a Bearer token", () => {
    const redacted = redactSecrets("upstream rejected: Authorization: Bearer abc123.def456-ghi789");
    expect(redacted).not.toContain("abc123.def456-ghi789");
    expect(redacted).toContain("Bearer ***");
  });

  it("masks common key=value / key: value secret patterns", () => {
    expect(redactSecrets("request failed, apiKey=sk_live_abcdef123456")).not.toContain("sk_live_abcdef123456");
    expect(redactSecrets("password: hunter2 rejected")).not.toContain("hunter2");
  });

  it("leaves an ordinary error message completely unchanged", () => {
    const message = "PostgreSQL query timed out after 30000ms";
    expect(redactSecrets(message)).toBe(message);
  });
});