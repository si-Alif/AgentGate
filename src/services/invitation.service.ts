import argon2 from "argon2";
import { prisma } from "../lib/prisma.js";
import { invitationRepository } from "../repositories/invitation.repository.js";
import { userRepository } from "../repositories/user.repository.js";
import { generateInvitationToken, hashInvitationToken } from "../lib/invitation-token.js";
import { enqueueInvitationEmail } from "../queue/email.queue.js";
import { env } from "../config/env.js";
import type { Role } from "../lib/roles.js";

export class EmailAlreadyRegisteredError extends Error {
  constructor() {
    super("EMAIL_ALREADY_REGISTERED");
  }
}

class InvitationClaimRaceError extends Error { }

export interface IssuedInvitation {
  id: string;
  email: string;
  role: string;
  expiresAt: Date;
}

export type AcceptInvitationResult =
  | { ok: true; user: { id: string; tenantId: string; email: string; role: string } }
  | { ok: false; reason: "not_found" | "revoked" | "already_accepted" | "expired" | "tenant_suspended" | "email_taken" };

function computeExpiresAt(): Date {
  return new Date(Date.now() + env.AGENTGATE_INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000);
}

export const invitationService = {
  /*
  - check if the user with the given email already exists or not . If does , throw EmailAlreadyRegisteredError.
  - if not , then check if an invitation has already been issued for the same email under given tenant or not
  - if yes , then reissue the invitation with new token and expiry date and return the invitation details
  - if not , then create a new invitation and return the invitation details
  */
  async createInvitation(
    tenantId: string,
    invitedByUserId: string,
    input: { email: string; role: Role }
  ): Promise<{ invitation: IssuedInvitation }> {
    const existingUser = await userRepository.findByEmail(input.email);
    if (existingUser) {
      throw new EmailAlreadyRegisteredError();
    }

    const rawToken = generateInvitationToken();
    const tokenHash = hashInvitationToken(rawToken);
    const expiresAt = computeExpiresAt();

    const existingPending = await invitationRepository.findActivePendingByTenantAndEmail(tenantId, input.email);

    const invitation = existingPending
      ? await invitationRepository.reissue(existingPending.id, {
        tokenHash,
        expiresAt,
        invitedByUserId,
        role: input.role,
      })
      : await invitationRepository.create({
        tenantId,
        email: input.email,
        role: input.role,
        invitedByUserId,
        tokenHash,
        expiresAt,
      });

    // Fire-and-forget, mirrors enqueueVerificationEmail()'s own
    // established contract — never awaited on this path, never
    // throws back to the caller.
    enqueueInvitationEmail({ email: input.email, rawToken, tenantId });

    return {
      invitation: { id: invitation.id, email: invitation.email, role: invitation.role, expiresAt: invitation.expiresAt },
    };
  },


  async acceptInvitation(rawToken: string, password: string): Promise<AcceptInvitationResult> {
    const tokenHash = hashInvitationToken(rawToken);
    const invitation = await invitationRepository.findByTokenHashWithTenant(tokenHash);

    if (!invitation) return { ok: false, reason: "not_found" };
    if (invitation.revokedAt !== null) return { ok: false, reason: "revoked" };
    if (invitation.acceptedAt !== null) return { ok: false, reason: "already_accepted" };
    if (invitation.expiresAt.getTime() <= Date.now()) return { ok: false, reason: "expired" };
    // Re-checked FRESH, never trusted from issuance time (mirrors
    // checkPermission()'s own tenant.deletedAt check, Week 3).
    if (invitation.tenant.deletedAt !== null) return { ok: false, reason: "tenant_suspended" };

    // Re-checked FRESH — time has passed since issuance; a DIFFERENT
    // pending invitation for the same email (a different tenant, or
    // this same tenant's reissued row racing another accept) may have
    // already claimed it.
    const existingUser = await userRepository.findByEmail(invitation.email);
    if (existingUser) return { ok: false, reason: "email_taken" };

    const passwordHash = await argon2.hash(password);

    // verify the user accepted the invitation and create the user in a transaction to avoid race conditions . Still , if there is a race condition regarding accepting the invitation , we will catch it and return the appropriate error message
    try {
      const user = await prisma.$transaction(async (tx) => {
        const claim = await invitationRepository.claimForAcceptance(invitation.id, tx);
        if (claim.count === 0) {
          // Someone else won the race between our read above and this
          // write — a genuinely concurrent second accept attempt.
          throw new InvitationClaimRaceError();
        }
        return userRepository.create(
          {
            tenantId: invitation.tenantId,
            email: invitation.email,
            passwordHash,
            role: invitation.role,
            isVerified: true, // token possession already proved email ownership
          },
          tx
        );
      });
      return { ok: true, user: { id: user.id, tenantId: user.tenantId, email: user.email, role: user.role } };
    } catch (err: any) {
      if (err instanceof InvitationClaimRaceError) return { ok: false, reason: "already_accepted" };
      // Second belt, alongside the pre-transaction check above: User.email's
      // own DB-level unique constraint as the final backstop against
      // the exact same race.
      if (err?.code === "P2002") return { ok: false, reason: "email_taken" };
      throw err;
    }
  },
};