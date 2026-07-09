import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createApp } from "../app.js";
import { prisma } from "../lib/prisma.js";
import { cleanupTenant } from "./helpers/test-tenant.factory.js"; 

describe("🔁 Full Auth Lifecycle", () => {
  let app: Awaited<ReturnType<typeof createApp>>;
  const slug = `e2e-tenant-${Date.now()}`;
  const email = `e2e-${Date.now()}@example.com`;
  const password = "TestPassword123!";
  let tenantId: string;

  beforeAll(async () => {
    app = await createApp();
  });

  afterAll(async () => {
    if (tenantId) await cleanupTenant(tenantId);
    await app.close();
  });

  it("register → verify → login → access → refresh → logout → post-logout refresh denied", async () => {
    // 1. Register
    const regRes = await app.inject({
      method: "POST",
      url: "/auth/register-tenant",
      payload: { tenantName: "E2E Tenant", slug, ownerEmail: email, password },
    });
    expect(regRes.statusCode).toBe(201);
    const regBody = JSON.parse(regRes.body);
    tenantId = regBody.tenant.id;
    expect(regBody.user.email).toBe(email);
    expect(JSON.stringify(regBody)).not.toContain("passwordHash");

    // 2. Login before verification should fail (account exists but unverified)
    const preVerifyLogin = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email, password },
    });
    expect(preVerifyLogin.statusCode).toBe(403);

    // 3. Pull verification token directly from DB (bypassing real email)
    const dbUser = await prisma.user.findUnique({ where: { email } });
    expect(dbUser?.verificationToken).toBeTruthy();
    // Confirm password is actually hashed, not stored in plaintext
    expect(dbUser?.passwordHash).not.toBe(password);
    expect(dbUser?.passwordHash.startsWith("$argon2")).toBe(true);

    const verifyRes = await app.inject({
      method: "GET",
      url: `/auth/verify-email?token=${dbUser!.verificationToken}`,
    });
    expect(verifyRes.statusCode).toBe(200);

    // 4. Login succeeds post-verification
    const loginRes = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email, password },
    });
    expect(loginRes.statusCode).toBe(200);
    const { accessToken, refreshToken } = JSON.parse(loginRes.body);
    expect(accessToken).toBeTruthy();
    expect(refreshToken).toBeTruthy();

    // 5. Access protected route
    const meRes = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(meRes.statusCode).toBe(200);

    // 6. Refresh
    const refreshRes = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: { refreshToken },
    });
    expect(refreshRes.statusCode).toBe(200);
    const newAccessToken = JSON.parse(refreshRes.body).accessToken;
    expect(newAccessToken).toBeTruthy();

    // 7. Logout
    const logoutRes = await app.inject({
      method: "POST",
      url: "/auth/logout",
      payload: { refreshToken },
    });
    expect(logoutRes.statusCode).toBe(200);

    // 8. Refresh after logout must fail
    const postLogoutRefresh = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: { refreshToken },
    });
    expect(postLogoutRefresh.statusCode).toBe(401);
  });

  it("wrong password returns the same error as non-existent email (no enumeration)", async () => {
    const wrongPassword = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email, password: "definitelyWrongPassword" },
    });
    const nonexistentEmail = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "does-not-exist@example.com", password: "whatever123" },
    });
    expect(wrongPassword.statusCode).toBe(nonexistentEmail.statusCode);
    expect(JSON.parse(wrongPassword.body).message).toBe(JSON.parse(nonexistentEmail.body).message);
  });
});