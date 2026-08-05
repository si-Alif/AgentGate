import { prisma } from "../lib/prisma.js";
import type { DbClient } from "../types/db-client.type.js";

export interface CreateInvitationInput {
  tenantId: string;
  email: string;
  role: string;
  invitedByUserId: string;
  tokenHash: string;
  expiresAt: Date;
}

export const invitationRepository = {
  create: (
    data: CreateInvitationInput,
    client: DbClient = prisma
  ) => client.invitation.create({ data }),

  findActivePendingByTenantAndEmail: (
    tenantId: string,
    email: string,
    client: DbClient = prisma
  ) =>
    client.invitation.findFirst({
      where: { tenantId, email, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
    }),

  // reissue a token by updating the tokenHash, expiresAt, invitedByUserId, and role
  reissue: (
    id: string,
    data: { tokenHash: string; expiresAt: Date; invitedByUserId: string; role: string },
    client: DbClient = prisma
  ) => client.invitation.update({ where: { id }, data }),

  // find an invitation by tokenHash, including the tenant's deletedAt field for validation so that we can reject invitations for deleted tenants
  findByTokenHashWithTenant: (
    tokenHash: string,
    client: DbClient = prisma
  ) =>
    client.invitation.findUnique({
      where: { tokenHash },
      include: { tenant: { select: { deletedAt: true } } },
    }),

  /**
   * The atomic claim. updateMany + count, never a bare update — the
   * SAME "count distinguishes matched-and-updated from no-match"
   * pattern agentRepository.rotateKey/updateById already established
   * `client` is REQUIRED (no default) — this must always
   * run inside the caller's own transaction; the missing default is
   * deliberate, forcing callers to pass `tx` explicitly rather than
   * accidentally running it non-transactionally.
   */
  claimForAcceptance: (
    id: string,
    client: DbClient) =>
    client.invitation.updateMany({
      where: { id, acceptedAt: null, revokedAt: null },
      data: { acceptedAt: new Date() },
    }),
};