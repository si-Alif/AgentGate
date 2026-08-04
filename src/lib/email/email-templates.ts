import { env } from "../../config/env.js";

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/**
 * Pure, dependency-free — same discipline as redactSecrets /
 * evaluateRateLimit: no I/O, trivially unit-testable.
 *
 * The link is built from AGENTGATE_APP_BASE_URL, never a relative
 * path — a relative "/auth/verify-email?token=..." is meaningless
 * inside an email client, which has no notion of "this server's own
 * origin" the way a browser tab does.
 */
export function renderVerificationEmail(params: { token: string }): RenderedEmail {
  const verifyUrl = new URL("/auth/verify-email", env.AGENTGATE_APP_BASE_URL);
  verifyUrl.searchParams.set("token", params.token);
  const link = verifyUrl.toString();

  const subject = "Verify your AgentGate account";

  const text = [
    "Welcome to AgentGate.",
    "",
    "Verify your email address to finish setting up your account:",
    link,
    "",
    "If you didn't request this, you can safely ignore this email.",
  ].join("\n");

  const html = `
    <div style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 0 auto;">
      <h2>Welcome to AgentGate</h2>
      <p>Verify your email address to finish setting up your account.</p>
      <p>
        <a href="${link}" style="display:inline-block;padding:10px 20px;background:#111;color:#fff;
           text-decoration:none;border-radius:6px;">Verify email</a>
      </p>
      <p style="color:#666;font-size:13px;">Or paste this link into your browser:<br/>${link}</p>
      <p style="color:#999;font-size:12px;">If you didn't request this, you can safely ignore this email.</p>
    </div>
  `.trim();

  return { subject, html, text };
}