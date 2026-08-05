import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { invitationRepository } from "../repositories/invitation.repository.js";
import { createTestTenant } from "./helpers/test-tenant.factory.js";
import { createApp } from "../app.js";

describe("invitationRepository", () => {
  it("GATE — claimForAcceptance: true concurrent claims on the SAME row resolve to exactly one count:1", async () => {
    const app = await createApp();
    const tenant = await createTestTenant(app);
    const invitation = await invitationRepository.create({
      tenantId: tenant.tenantId,
      email: `invitee-${crypto.randomUUID()}@example.com`,
      role: "member",
      invitedByUserId: tenant.userId,
      tokenHash: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 60_000),
    });

    const results = await Promise.all(
      Array.from({ length: 3 }, () => prisma.$transaction((tx) => invitationRepository.claimForAcceptance(invitation.id, tx)))
    );
    expect(results.filter((r) => r.count === 1)).toHaveLength(1);
    expect(results.filter((r) => r.count === 0)).toHaveLength(2);

    await app.close();
  });

  it("findActivePendingByTenantAndEmail excludes an expired row", async () => {
    const app = await createApp();
    const tenant = await createTestTenant(app);
    const email = `expired-${crypto.randomUUID()}@example.com`;
    await invitationRepository.create({
      tenantId: tenant.tenantId, email, role: "member", invitedByUserId: tenant.userId,
      tokenHash: crypto.randomUUID(), expiresAt: new Date(Date.now() - 1000),
    });
    expect(await invitationRepository.findActivePendingByTenantAndEmail(tenant.tenantId, email)).toBeNull();
    await app.close();
  });
});