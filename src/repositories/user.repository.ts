import { prisma } from "../lib/prisma.js";

export const userRepository = {
  findByEmail: (email: string) => prisma.user.findUnique({ where: { email } }),

  findById: (id: string, tenantId: string) =>
    prisma.user.findFirst({ where: { id, tenantId } }),

  findByVerificationToken: (token: string) =>
    prisma.user.findFirst({ where: { verificationToken: token } }),

  create: (data: {
    tenantId: string;
    email: string;
    passwordHash: string;
    role: string;
    verificationToken: string;
  }) => prisma.user.create({ data }),

  updateVerified: (id: string) =>
    prisma.user.update({
      where: { id },
      data: { isVerified: true, verificationToken: null },
    }),

  updateRefreshTokenHash: (id: string, hash: string | null) =>
    prisma.user.update({
      where: { id },
      data: { refreshTokenHash: hash },
    }),
};