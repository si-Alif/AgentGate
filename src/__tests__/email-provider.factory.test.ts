// src/__tests__/email-provider.factory.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { getEmailProvider, resetEmailProviderForTest } from "../lib/email/email-provider.factory.js";
import { ConsoleEmailProvider } from "../lib/email/providers/console-email.provider.js";
import { SendGridEmailProvider } from "../lib/email/providers/sendgrid-email.provider.js";
import { env } from "../config/env.js";

describe("getEmailProvider", () => {
  beforeEach(() => resetEmailProviderForTest());

  it("returns ConsoleEmailProvider by default", () => {
    (env as any).AGENTGATE_EMAIL_PROVIDER = "console";
    expect(getEmailProvider()).toBeInstanceOf(ConsoleEmailProvider);
  });

  it("returns SendGridEmailProvider when configured", () => {
    (env as any).AGENTGATE_EMAIL_PROVIDER = "sendgrid";
    (env as any).AGENTGATE_SENDGRID_API_KEY = "test-key";
    expect(getEmailProvider()).toBeInstanceOf(SendGridEmailProvider);
  });

  it("caches the instance across calls", () => {
    (env as any).AGENTGATE_EMAIL_PROVIDER = "console";
    expect(getEmailProvider()).toBe(getEmailProvider());
  });
});