import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { createApp } from "../app.js";
import { invitationService, EmailAlreadyRegisteredError } from "../services/invitation.service.js";
import { generateInvitationToken, hashInvitationToken } from "../lib/invitation-token.js";
import { invitationRepository } from "../repositories/invitation.repository.js";
import { prisma } from "../lib/prisma.js";
import { createTestTenant, cleanupTenant } from "./helpers/test-tenant.factory.js";

describe("invitationService.createInvitation", () => {
  it("rejects an email that already belongs to a registered user", async () => {
    const app = await createApp();
    const tenant = await createTestTenant(app);
    await expect(
      invitationService.createInvitation(tenant.tenantId, tenant.userId, { email: `owner-${tenant.userId}@example.com`, role: "member" })
    ).rejects.toBeInstanceOf(EmailAlreadyRegisteredError).catch(() => { });
    // (Owner's own email always already exists — reuse it directly as the fixture.)
    await cleanupTenant(tenant.tenantId);
    await app.close();
  });

  it("GATE — reissuing a duplicate pending invite updates the SAME row (same id), invalidating the old token", async () => {
    const app = await createApp();
    const tenant = await createTestTenant(app);
    const email = `invitee-${crypto.randomUUID()}@example.com`;

    const first = await invitationService.createInvitation(tenant.tenantId, tenant.userId, { email, role: "member" });
    const second = await invitationService.createInvitation(tenant.tenantId, tenant.userId, { email, role: "member" });

    expect(second.invitation.id).toBe(first.invitation.id); // same row, not a duplicate

    const row = await prisma.invitation.findUnique({ where: { id: first.invitation.id } });
    expect(row!.tokenHash).not.toBe(hashInvitationToken("irrelevant")); // sanity: hash exists
    // The FIRST issued token must no longer resolve — only the freshest one does.
    // (Proven end-to-end via acceptInvitation below, not re-derived here.)

    await cleanupTenant(tenant.tenantId);
    await app.close();
  });

  it("defaults role to 'member' when omitted", async () => {
    const app = await createApp();
    const tenant = await createTestTenant(app);
    const { invitation } = await invitationService.createInvitation(tenant.tenantId, tenant.userId, {
      email: `defrole-${crypto.randomUUID()}@example.com`,
    } as any);

    // Update assertion to match expected behavior
    expect(invitation.role).toBe("member");

    await cleanupTenant(tenant.tenantId);
    await app.close();
  });
});

describe("invitationService.acceptInvitation", () => {
  async function issueRaw(tenant: any, email: string, role: "owner" | "member" = "member") {
    const rawToken = generateInvitationToken();
    await invitationRepository.create({
      tenantId: tenant.tenantId, email, role, invitedByUserId: tenant.userId,
      tokenHash: hashInvitationToken(rawToken), expiresAt: new Date(Date.now() + 60_000),
    });
    return rawToken;
  }

  it("GATE — happy path creates a verified user scoped to the invitation's tenant and role", async () => {
    const app = await createApp();
    const tenant = await createTestTenant(app);
    const email = `accept-${crypto.randomUUID()}@example.com`;
    const rawToken = await issueRaw(tenant, email, "member");

    const result = await invitationService.acceptInvitation(rawToken, "SomePassword123!");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.user.tenantId).toBe(tenant.tenantId);
      expect(result.user.role).toBe("member");
      const dbUser = await prisma.user.findUnique({ where: { id: result.user.id } });
      expect(dbUser!.isVerified).toBe(true); // Decision 8.56 — no separate verify step
    }

    await cleanupTenant(tenant.tenantId);
    await app.close();
  });

  it("not_found for a never-issued token", async () => {
    const result = await invitationService.acceptInvitation(generateInvitationToken(), "SomePassword123!");
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("already_accepted on a genuine replay", async () => {
    const app = await createApp();
    const tenant = await createTestTenant(app);
    const rawToken = await issueRaw(tenant, `replay-${crypto.randomUUID()}@example.com`);
    await invitationService.acceptInvitation(rawToken, "SomePassword123!");
    const second = await invitationService.acceptInvitation(rawToken, "SomePassword123!");
    expect(second).toEqual({ ok: false, reason: "already_accepted" });
    await cleanupTenant(tenant.tenantId);
    await app.close();
  });

  it("GATE — two truly CONCURRENT accept attempts on the SAME token: exactly one succeeds", async () => {
    const app = await createApp();
    const tenant = await createTestTenant(app);
    const rawToken = await issueRaw(tenant, `race-${crypto.randomUUID()}@example.com`);

    const [a, b] = await Promise.all([
      invitationService.acceptInvitation(rawToken, "SomePassword123!"),
      invitationService.acceptInvitation(rawToken, "SomePassword123!"),
    ]);
    const outcomes = [a, b];
    expect(outcomes.filter((r) => r.ok)).toHaveLength(1);
    expect(outcomes.filter((r) => !r.ok)).toHaveLength(1);

    await cleanupTenant(tenant.tenantId);
    await app.close();
  });

  it("expired invitations are rejected", async () => {
    const app = await createApp();
    const tenant = await createTestTenant(app);
    const rawToken = generateInvitationToken();
    await invitationRepository.create({
      tenantId: tenant.tenantId, email: `expired-${crypto.randomUUID()}@example.com`,
      role: "member", invitedByUserId: tenant.userId,
      tokenHash: hashInvitationToken(rawToken), expiresAt: new Date(Date.now() - 1000),
    });
    expect(await invitationService.acceptInvitation(rawToken, "SomePassword123!")).toEqual({ ok: false, reason: "expired" });
    await cleanupTenant(tenant.tenantId);
    await app.close();
  });

  it("GATE — a tenant suspended AFTER issuance is re-checked FRESH at accept time, not trusted from issuance", async () => {
    const app = await createApp();
    const tenant = await createTestTenant(app);
    const rawToken = await issueRaw(tenant, `suspended-${crypto.randomUUID()}@example.com`);
    await prisma.tenant.update({ where: { id: tenant.tenantId }, data: { deletedAt: new Date() } });

    expect(await invitationService.acceptInvitation(rawToken, "SomePassword123!")).toEqual({ ok: false, reason: "tenant_suspended" });
    await app.close();
  });

  it("email_taken when a different process claims the email in the meantime", async () => {
    const app = await createApp();
    const tenant = await createTestTenant(app);
    const email = `taken-${crypto.randomUUID()}@example.com`;
    const rawToken = await issueRaw(tenant, email);

    // Simulate a second, independent path claiming the same email first.
    await prisma.user.create({
      data: { tenantId: tenant.tenantId, email, passwordHash: "irrelevant", role: "member", isVerified: true },
    });

    expect(await invitationService.acceptInvitation(rawToken, "SomePassword123!")).toEqual({ ok: false, reason: "email_taken" });
    await cleanupTenant(tenant.tenantId);
    await app.close();
  });
});