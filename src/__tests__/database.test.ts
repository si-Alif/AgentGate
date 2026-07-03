import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../lib/prisma.js";
import { tenantRepository } from "../repositories/tenant.repository.js";
import { userRepository } from "../repositories/user.repository.js";

describe("Database connection", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("executes a raw query", async () => {
    const result = await prisma.$queryRaw<Array<{ result: number }>>`SELECT 1 AS result`;

    expect(result[0]?.result).toBe(1);
  });

  it("creates and retrieves a tenant by slug", async () => {
    const slug = `tenant-${Date.now()}`;

    const tenant = await tenantRepository.create({
      name: "Test Tenant",
      slug,
    });

    const found = await tenantRepository.findBySlug(slug);

    expect(found?.id).toBe(tenant.id);
    expect(found?.slug).toBe(slug);

    await prisma.tenant.delete({ where: { id: tenant.id } });
  });

  it("creates a user linked to a tenant", async () => {
    const tenant = await tenantRepository.create({
      name: "User Tenant",
      slug: `user-tenant-${Date.now()}`,
    });

    const user = await userRepository.create({
      tenantId: tenant.id,
      email: `user-${Date.now()}@example.com`,
      passwordHash: "$argon2id$v=19$m=65536,t=3,p=4$test$hash",
      role: "owner",
      verificationToken: `token-${Date.now()}`,
    });

    const found = await userRepository.findById(user.id, tenant.id);

    expect(found?.id).toBe(user.id);
    expect(found?.tenantId).toBe(tenant.id);

    await prisma.tenant.delete({ where: { id: tenant.id } });
  });
});