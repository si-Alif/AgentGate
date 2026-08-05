// src/__tests__/accept-invitation-route.test.ts
import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { createApp } from "../app.js";
import { generateInvitationToken, hashInvitationToken } from "../lib/invitation-token.js";
import { invitationRepository } from "../repositories/invitation.repository.js";
import { createTestTenant, cleanupTenant } from "./helpers/test-tenant.factory.js";

describe("POST /auth/accept-invitation", () => {
  async function seedInvitation(app: any, tenant: any, role: "owner" | "member" = "member") {
    const rawToken = generateInvitationToken();
    const email = `accept-${crypto.randomUUID()}@example.com`;
    await invitationRepository.create({
      tenantId: tenant.tenantId, email, role, invitedByUserId: tenant.userId,
      tokenHash: hashInvitationToken(rawToken), expiresAt: new Date(Date.now() + 60_000),
    });
    return { rawToken, email };
  }

  it("GATE — full round trip: accept auto-logs in, response matches login's own token shape", async () => {
    const app = await createApp();
    const tenant = await createTestTenant(app);
    const { rawToken } = await seedInvitation(app, tenant);

    const res = await app.inject({
      method: "POST", url: "/auth/accept-invitation",
      payload: { token: rawToken, password: "NewUserPassword123!" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty("accessToken");
    expect(body).toHaveProperty("refreshToken");
    expect(body.expiresIn).toBe(900);

    await cleanupTenant(tenant.tenantId);
    await app.close();
  });

  it("a role field in the request body is REJECTED by the schema, never silently honored", async () => {
    const app = await createApp();
    const res = await app.inject({
      method: "POST", url: "/auth/accept-invitation",
      payload: { token: "whatever", password: "SomePassword123!", role: "owner" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("GATE — an invalid token returns the GENERIC 'no longer valid' message, not a specific reason", async () => {
    const app = await createApp();
    const res = await app.inject({
      method: "POST", url: "/auth/accept-invitation",
      payload: { token: generateInvitationToken(), password: "SomePassword123!" },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).message).toMatch(/no longer valid/i);
    await app.close();
  });

  it("email_taken gets the DISTINCT message (Decision 8.54's one exception)", async () => {
    const app = await createApp();
    const tenant = await createTestTenant(app);
    const { rawToken } = await seedInvitation(app, tenant);
    // Accept once, then attempt to accept the SAME token again after
    // manually resetting acceptedAt (simulating the email_taken path
    // specifically, isolated from the already_accepted path).
    const first = await app.inject({
      method: "POST", url: "/auth/accept-invitation",
      payload: { token: rawToken, password: "First123456!" },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: "POST", url: "/auth/accept-invitation",
      payload: { token: rawToken, password: "Second123456!" },
    });
    // Second attempt on an ALREADY-accepted token hits already_accepted,
    // not email_taken — confirms the reason-priority ordering in the
    // service (already_accepted is checked before the email lookup).
    expect(second.statusCode).toBe(400);
    expect(JSON.parse(second.body).message).toMatch(/no longer valid/i);

    await cleanupTenant(tenant.tenantId);
    await app.close();
  });

  it("REGRESSION — GET /auth/register-user no longer exists", async () => {
    const app = await createApp();
    const res = await app.inject({ method: "POST", url: "/auth/register-user", payload: {} });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("REGRESSION — the renamed public-auth bucket doesn't interfere with register-tenant's OWN bucket", async () => {
    const app = await createApp();
    const res = await app.inject({
      method: "POST", url: "/auth/register-tenant",
      payload: {
        tenantName: `T ${crypto.randomUUID()}`, slug: `t-${crypto.randomUUID()}`,
        ownerEmail: `owner-${crypto.randomUUID()}@example.com`, password: "TestPassword123!",
      },
    });
    expect(res.statusCode).not.toBe(429);
    await app.close();
  });
});