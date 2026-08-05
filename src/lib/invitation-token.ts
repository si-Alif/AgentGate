import crypto from "node:crypto";
import { env } from "../config/env.js";

/**
 * Hashing: HMAC-SHA256, keyed by a DEDICATED
 * AGENTGATE_INVITATION_TOKEN_SECRET — not Argon2, and not shared with
 * any other secret's pepper. Acceptance arrives with ONLY the raw
 * token — no known user/invitation ID to verify against — so the
 * lookup has to run the other direction: "find the row whose hash
 * equals this." Argon2's random per-hash salt makes that impossible;
 * HMAC is deterministic (same input -> same digest), so a direct,
 * indexed `WHERE token_hash = ?` lookup is safe and correct.
 * the design memo this module implements
 * described matching refreshTokenHash's "HMAC" approach — the real
 * refreshTokenHash is Argon2-hashed and could not serve this
 * lookup-by-value use case either.
 */
const TOKEN_BYTES = 32;

export function generateInvitationToken(): string {
  return crypto.randomBytes(TOKEN_BYTES).toString("base64url");
}

export function hashInvitationToken(rawToken: string): string {
  return crypto.createHmac("sha256", env.AGENTGATE_INVITATION_TOKEN_SECRET).update(rawToken).digest("hex");
}