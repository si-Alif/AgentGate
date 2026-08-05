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

export function renderInvitationEmail(params: { token: string }): RenderedEmail {
  const acceptApiUrl = new URL("/auth/accept-invitation", env.AGENTGATE_APP_BASE_URL).toString();
  const referenceLink = new URL("/accept-invitation", env.AGENTGATE_APP_BASE_URL);
  referenceLink.searchParams.set("token", params.token);

  const subject = "You've been invited to join a team on AgentGate";

  // AgentGate's MVP is API-first (PRD §7 explicitly excludes a
  // dashboard UI) — a "click this link" call to action would 404
  // today. The primary content is a copyable token + a working curl
  // example instead. The reference link is included for forward
  // compatibility only, once a real dashboard exists to receive it.
  const text = [
    "You've been invited to join a team on AgentGate.",
    "",
    "There's no web page to click through yet — use the token below",
    "directly with the accept-invitation endpoint to set your password",
    "and get an access token in one step:",
    "",
    `  curl -X POST ${acceptApiUrl} \\`,
    `    -H "Content-Type: application/json" \\`,
    `    -d '{"token": "${params.token}", "password": "<choose-a-password>"}'`,
    "",
    `(Reference link, for a future dashboard: ${referenceLink.toString()})`,
    "",
    "This invitation expires soon. If you weren't expecting this, you can ignore this email.",
  ].join("\n");

  const html = `
    <div style="font-family: -apple-system, sans-serif; max-width: 520px; margin: 0 auto;">
      <h2>You've been invited to join a team on AgentGate</h2>
      <p>There's no web page to click through yet — use the token below
         directly with the <code>accept-invitation</code> endpoint to set
         your password and get an access token in one step:</p>
      <pre style="background:#f5f5f5;padding:12px;border-radius:6px;overflow-x:auto;font-size:13px;">curl -X POST ${acceptApiUrl} \\
  -H "Content-Type: application/json" \\
  -d '{"token": "${params.token}", "password": "&lt;choose-a-password&gt;"}'</pre>
      <p style="color:#666;font-size:13px;">Reference link (for a future dashboard): ${referenceLink.toString()}</p>
      <p style="color:#999;font-size:12px;">This invitation expires soon. If you weren't expecting this, you can ignore this email.</p>
    </div>
  `.trim();

  return { subject, html, text };
}