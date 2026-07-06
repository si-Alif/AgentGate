import type {DbClient} from "../types/db-client.type.js"
import { prisma } from "../lib/prisma.js";

export const userRepository = {
  findByEmail: (email: string, client:DbClient  = prisma) =>
    client.user.findUnique({ where: { email } }),

  findById: (id: string, tenantId: string, client:DbClient  = prisma) =>
    client.user.findFirst({ where: { id, tenantId } }),

  findByVerificationToken: (token: string, client:DbClient  = prisma) =>
    client.user.findFirst({ where: { verificationToken: token } }),

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

  updateVerified: (id: string, client: DbClient = prisma) =>
    client.user.update({
      where: { id },
      data: { isVerified: true, verificationToken: null },
    }),

  updateRefreshTokenHash: (id: string, hash: string | null, client: DbClient = prisma) =>
    client.user.update({
      where: { id },
      data: { refreshTokenHash: hash },
    }),
};