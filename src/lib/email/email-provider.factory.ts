import { env } from "../../config/env.js";
import { ConsoleEmailProvider } from "./providers/console-email.provider.js";
import { SendGridEmailProvider } from "./providers/sendgrid-email.provider.js";
import type { EmailProvider } from "./email-provider.js";

let cachedProvider: EmailProvider | null = null;

/** The single seam through which the worker ever obtains a provider — never a concrete class directly. */
export function getEmailProvider(): EmailProvider {
  if (cachedProvider) return cachedProvider;
  cachedProvider = env.AGENTGATE_EMAIL_PROVIDER === "sendgrid" ? new SendGridEmailProvider() : new ConsoleEmailProvider();
  return cachedProvider;
}

/** Test-only seam. Never called in production. */
export function resetEmailProviderForTest(): void {
  cachedProvider = null;
}