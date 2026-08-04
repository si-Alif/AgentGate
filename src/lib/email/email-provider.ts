export interface OutboundEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface EmailSendResult {
  provider: string;
  messageId?: string;
}

/**
 * A permanent failure (bad recipient, malformed request, revoked key)
 * should NEVER be retried — retrying it three times with backoff just
 * delays an inevitable dead-letter by 36 seconds. A transient failure
 * (network blip, 5xx, provider rate limit) SHOULD go through the
 * queue's normal backoff. Mirrors the audit worker's own
 * SCHEMA_VALIDATION_FAILED vs. INFRA_FAILURE_EXHAUSTED split ,
 * applied here to provider-level errors instead of payload errors.
 */
export class PermanentEmailError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "PermanentEmailError";
  }
}

export class TransientEmailError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "TransientEmailError";
  }
}

export interface EmailProvider {
  readonly name: string;
  send(message: OutboundEmail): Promise<EmailSendResult>;
}