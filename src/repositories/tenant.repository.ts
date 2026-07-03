import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

export const tenantRepository = {
  findById: (id: string) => prisma.tenant.findUnique({ where: { id } }),

  findBySlug: (slug: string) => prisma.tenant.findUnique({ where: { slug } }),

  create: (data: { name: string; slug: string; settings?: Prisma.InputJsonValue }) =>
    prisma.tenant.create({
      data: {
        name: data.name,
        slug: data.slug,
        settings: data.settings ?? {},
      },
    }),
};