// src/__tests__/invitations-route.test.ts
import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { createApp } from "../app.js";
import { createTestTenant, cleanupTenant } from "./helpers/test-tenant.factory.js";

describe("POST /api/users/invitations", () => {
  it("GATE — an Owner can issue an invitation; response NEVER includes a token field", async () => {
    const app = await createApp();
    const tenant = await createTestTenant(app); // Owner by construction (Week 1 Day 3)

    const res = await app.inject({
      method: "POST",
      url: "/api/users/invitations",
      headers: { Authorization: `Bearer ${tenant.accessToken}` },
      payload: { email: `invitee-${crypto.randomUUID()}@example.com` },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.role).toBe("member"); // default
    expect("token" in body).toBe(false);
    expect("tokenHash" in body).toBe(false);

    await cleanupTenant(tenant.tenantId);
    await app.close();
  });

  it("GATE — a member-role user (created via this SAME feature) is forbidden from issuing invitations", async () => {
    const app = await createApp();
    const tenant = await createTestTenant(app);
    const email = `member-${crypto.randomUUID()}@example.com`;

    const issueRes = await app.inject({
      method: "POST", url: "/api/users/invitations",
      headers: { Authorization: `Bearer ${tenant.accessToken}` },
      payload: { email, role: "member" },
    });
    const { invitationService } = await import("../services/invitation.service.js");
    // (Route doesn't return the raw token — accept via the SERVICE directly
    // for this test's own bootstrap, matching invitation.service.test.ts's
    // own convention of issuing raw tokens outside the HTTP layer.)
    const { invitationRepository } = await import("../repositories/invitation.repository.js");
    const { generateInvitationToken, hashInvitationToken } = await import("../lib/invitation-token.js");
    const rawToken = generateInvitationToken();
    const pending = await invitationRepository.findActivePendingByTenantAndEmail(tenant.tenantId, email);
    await invitationRepository.reissue(pending!.id, {
      tokenHash: hashInvitationToken(rawToken), expiresAt: pending!.expiresAt, invitedByUserId: tenant.userId, role: "member",
    });
    const accepted = await invitationService.acceptInvitation(rawToken, "MemberPassword123!");
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) throw new Error("setup failed");

    const memberLogin = await app.inject({
      method: "POST", url: "/auth/login",
      payload: { email, password: "MemberPassword123!" },
    });

    expect(memberLogin.statusCode, `Member login failed: ${memberLogin.body}`).toBe(200);
    const { accessToken: memberToken } = JSON.parse(memberLogin.body);

    const forbidden = await app.inject({
      method: "POST", url: "/api/users/invitations",
      headers: { Authorization: `Bearer ${memberToken}` },
      payload: { email: `another-${crypto.randomUUID()}@example.com` },
    });
    expect(forbidden.statusCode).toBe(403);

    await cleanupTenant(tenant.tenantId);
    await app.close();
  });

  it("rejects duplicate-email issuance with 409", async () => {
    const app = await createApp();
    const tenant = await createTestTenant(app);

    const res = await app.inject({
      method: "POST", url: "/api/users/invitations",
      headers: { Authorization: `Bearer ${tenant.accessToken}` },
      payload: { email: `owner-${tenant.userId}@example.com` }, // arbitrary — Owner's own real email is simplest
    });
    // Using the Owner's OWN email guarantees an existing-user hit regardless of fixture details.
    const { prisma } = await import("../lib/prisma.js");
    const owner = await prisma.user.findUniqueOrThrow({ where: { id: tenant.userId } });
    const ownerEmailRes = await app.inject({
      method: "POST", url: "/api/users/invitations",
      headers: { Authorization: `Bearer ${tenant.accessToken}` },
      payload: { email: owner.email },
    });
    expect(ownerEmailRes.statusCode).toBe(409);

    await cleanupTenant(tenant.tenantId);
    await app.close();
  });
});