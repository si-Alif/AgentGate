import type { DbClient } from "../types/db-client.type.js";
import { prisma } from "../lib/prisma.js";

export const userRepository = {
  findByEmail: (email: string, client: DbClient = prisma) =>
    client.user.findFirst({
      where: { email, deletedAt: null, tenant: { deletedAt: null } },
    }),

  findById: (id: string, tenantId: string, client: DbClient = prisma) =>
    client.user.findFirst({
      where: { id, tenantId, deletedAt: null, tenant: { deletedAt: null } },
    }),

  // /**
  //  * Used for flows that already have tenant context; avoids tenant leakage.
  //  */
  // findByIdOnly: (id: string, client: DbClient = prisma) =>
  //   client.user.findFirst({ where: { id, deletedAt: null, tenant: { deletedAt: null } } }),

  findByRefreshTokenHash: (hash: string, client: DbClient = prisma) =>
    client.user.findFirst({
      where: { refreshTokenHash: hash, deletedAt: null, tenant: { deletedAt: null } },
    }),

  // Used by auth verification flow
  findByVerificationToken: (token: string, client: DbClient = prisma) =>
    client.user.findFirst({
      where: { verificationToken: token, deletedAt: null, tenant: { deletedAt: null } },
    }),

  create: (
    data: {
      tenantId: string;
      email: string;
      passwordHash: string;
      role: string;
      verificationToken: string;
    },
    client: DbClient = prisma
  ) => client.user.create({ data }),

  updateVerified: (id: string, tenantId: string, client: DbClient = prisma) =>
    client.user.update({
      where: { id, tenantId },
      data: { isVerified: true, verificationToken: null },
    }),

  updateRefreshTokenHash: (
    id: string,
    tenantId: string,
    hash: string | null,
    client: DbClient = prisma
  ) =>
    client.user.update({
      where: { id, tenantId },
      data: { refreshTokenHash: hash },
    }),
};
