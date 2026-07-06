import type {DbClient} from "../types/db-client.type.js"
import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

export const tenantRepository = {
  findById: (id: string, client: DbClient = prisma) =>
    client.tenant.findUnique({ where: { id } }),

  findBySlug: (slug: string, client: DbClient = prisma) =>
    client.tenant.findUnique({ where: { slug } }),

  create: (
    data: { name: string; slug: string; settings?: Prisma.InputJsonValue },
    client: DbClient = prisma
  ) =>
    client.tenant.create({
      data: {
        name: data.name,
        slug: data.slug,
        settings: data.settings ?? {},
      },
    }),
};