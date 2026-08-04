import type { EmailProvider, OutboundEmail, EmailSendResult } from "../email-provider.js";

/** Dev/test default (Decision 8.29). Swapping to real delivery is one env var, never a code change. */
export class ConsoleEmailProvider implements EmailProvider {
  readonly name = "console";

  async send(message: OutboundEmail): Promise<EmailSendResult> {
    console.log(`\n[EMAIL:CONSOLE] ─────────────────────────────`);
    console.log(`  To:      ${message.to}`);
    console.log(`  Subject: ${message.subject}`);
    console.log(`  ${message.text}`);
    console.log(`──────────────────────────────────────────\n`);
    return { provider: this.name };
  }
}