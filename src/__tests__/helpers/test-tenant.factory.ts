import type { FastifyInstance } from "fastify";
import { prisma } from "../../lib/prisma.js";

interface TestTenantHandle {
  tenantId: string;
  userId: string;
  email: string;
  accessToken: string;
  refreshToken: string;
}

/**
 * Registers a fully verified tenant + owner + logs them in.
 * Returns everything a downstream test needs, and the caller
 * is responsible for passing tenantId to `cleanupTenant`.
 *
 * Centralizing this now means Week 2's agent/tool tests, Week 3's
 * permission tests, and Week 6's MCP client tests all provision
 * their fixture tenant identically — no drift between spec files.
 */
export async function createTestTenant(
  app: FastifyInstance,
  opts: { password?: string } = {}
): Promise<TestTenantHandle> {
  const password = opts.password ?? "StrongPass123!";
  const slug = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `owner-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.local`;

  await app.inject({
    method: "POST",
    url: "/auth/register-tenant",
    payload: { tenantName: "Test Co", slug, ownerEmail: email, password },
  });

  const user = await prisma.user.findUniqueOrThrow({ where: { email } });

  await app.inject({
    method: "GET",
    url: `/auth/verify-email?token=${user.verificationToken}`,
  });

  const loginRes = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { email, password },
  });

  const { accessToken, refreshToken } = loginRes.json() as {
    accessToken: string;
    refreshToken: string;
  };

  return {
    tenantId: user.tenantId,
    userId: user.id,
    email,
    accessToken,
    refreshToken,
  };
}

/**
 * Scoped teardown — deletes exactly the tenant this test created,
 * via cascade, and NOTHING else. Safe to call in serialized OR
 * (future) parallel execution, unlike a blanket deleteMany().
 *
 * As agents/tools/permissions are added in Week 2+, the Prisma
 * cascade (onDelete: Cascade on the FK) handles them automatically —
 * this function does not need to change.
 */
export async function cleanupTenant(tenantId: string): Promise<void> {
  await prisma.tenant.delete({ where: { id: tenantId } }).catch((err) => {
    // Already deleted by a prior assertion path (e.g. a test that
    // explicitly deletes as part of what it's proving) — not an error.
    if (err.code !== "P2025") throw err;
  });
}