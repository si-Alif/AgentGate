import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { createTestTenant, cleanupTenant } from "./helpers/test-tenant.factory.js";
import type { FastifyInstance } from "fastify";
import { prisma } from "../lib/prisma.js";

describe("Day 4 — JWT auth lifecycle", () => {
  let app: FastifyInstance;
  const createdTenantIds: string[] = [];

  beforeAll(async () => {
    app = await createApp();
  });

  afterEach(async () => {
    // Only ever removes what THIS test file created.
    await Promise.all(createdTenantIds.splice(0).map(cleanupTenant));
  });

  afterAll(async () => {
    await app.close();
  });

  it("login: success returns accessToken + refreshToken, without leaking secrets", async () => {
    const tenant = await createTestTenant(app);
    createdTenantIds.push(tenant.tenantId);

    expect(typeof tenant.accessToken).toBe("string");
    expect(typeof tenant.refreshToken).toBe("string");

    const stored = await prisma.user.findUnique({
      where: { id: tenant.userId },
      select: { refreshTokenHash: true },
    });
    expect(stored?.refreshTokenHash).toBeTruthy();
    expect(stored?.refreshTokenHash).not.toBe(tenant.refreshToken);
  });

  it("rejects a tampered access token on /api/me", async () => {
    const tenant = await createTestTenant(app);
    createdTenantIds.push(tenant.tenantId);

    // Flip last 2 chars to corrupt signature/payload.
    const tampered = tenant.accessToken.slice(0, -2) + "xx";

    const res = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { authorization: `Bearer ${tampered}` },
    });

    expect(res.statusCode).toBe(401);
  });

  it("rejects missing Authorization header on /api/me with 401", async () => {
    const tenant = await createTestTenant(app);
    createdTenantIds.push(tenant.tenantId);

    const res = await app.inject({
      method: "GET",
      url: "/api/me",
      // no Authorization header
    });

    expect(res.statusCode).toBe(401);
  });

  it("rejects malformed token on /api/me with 401", async () => {
    const tenant = await createTestTenant(app);
    createdTenantIds.push(tenant.tenantId);

    const res = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { authorization: "Bearer not-a-real-jwt" },
    });

    expect(res.statusCode).toBe(401);
  });

  it("rejects wrong Authorization scheme (Basic) on /api/me with 401", async () => {
    const tenant = await createTestTenant(app);
    createdTenantIds.push(tenant.tenantId);

    const res = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { authorization: "Basic dGVzdDp0ZXN0" },
    });

    expect(res.statusCode).toBe(401);
  });

  // remaining tests follow the same pattern — factory + scoped cleanup
});
