import { request } from "undici";
import { env } from "../../../config/env.js";
import { PermanentEmailError, TransientEmailError } from "../email-provider.js";
import type { EmailProvider, OutboundEmail, EmailSendResult } from "../email-provider.js";

const SENDGRID_ENDPOINT = "https://api.sendgrid.com/v3/mail/send";

/**
 * Calls SendGrid's v3 Mail Send API directly via undici — zero new
 * npm dependency. Failure classification mirrors the
 * audit worker's dead-letter split: a 4xx is a PermanentEmailError
 * (retrying changes nothing); a 5xx or network-level failure is a
 * TransientEmailError (the queue's own backoff is the right tool).
 */
export class SendGridEmailProvider implements EmailProvider {
  readonly name = "sendgrid";

  async send(message: OutboundEmail): Promise<EmailSendResult> {
    if (!env.AGENTGATE_SENDGRID_API_KEY) {
      // Unreachable in practice — env.ts's own superRefine already
      // fails boot before this combination is possible. Defensive only.
      throw new PermanentEmailError("AGENTGATE_SENDGRID_API_KEY is not configured");
    }

    let response;
    try {
      response = await request(SENDGRID_ENDPOINT, {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.AGENTGATE_SENDGRID_API_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: message.to }] }],
          from: { email: env.AGENTGATE_EMAIL_FROM_ADDRESS, name: env.AGENTGATE_EMAIL_FROM_NAME },
          subject: message.subject,
          content: [
            { type: "text/plain", value: message.text },
            { type: "text/html", value: message.html },
          ],
        }),
        // A send must never hang the worker indefinitely — same
        // AbortController discipline established Week 4.
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      throw new TransientEmailError("SendGrid request failed at the network layer", err);
    }

    // if successful then return response
    if (response.statusCode >= 200 && response.statusCode < 300) {
      const messageId = response.headers["x-message-id"];
      // wait for the promise to resolve and when done empty out the response
      await response.body.dump(); // drain the (empty, on success) body
      return { provider: this.name, messageId: typeof messageId === "string" ? messageId : "" };
    }

    // if we reached here that means error happened and to handle it :
    // - wait for the promise to resolve and then retrieve the text of the response body (if any) to include in the error message
    // - if any error happened while parsing , catch it and replace with "" , to ensure bodyText is always a string
    const bodyText = await response.body.text().catch(() => "");

    if (response.statusCode >= 500) {
      throw new TransientEmailError(`SendGrid returned ${response.statusCode}: ${bodyText.slice(0, 500)}`);
    }
    // 4xx — malformed request, bad recipient, unauthorized. Never worth retrying as-is.
    throw new PermanentEmailError(`SendGrid rejected the request (${response.statusCode}): ${bodyText.slice(0, 500)}`);
  }
}