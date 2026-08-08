import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp } from "../app.js";
import { createTestTenant, cleanupTenant } from "./helpers/test-tenant.factory.js";
import { prisma } from "../lib/prisma.js";

describe("Day 6 — Tenant Isolation (DB-scoped proof)", () => {
  let app: FastifyInstance;

  const created: string[] = [];

  let tenantA: Awaited<ReturnType<typeof createTestTenant>> | null = null;
  let tenantB: Awaited<ReturnType<typeof createTestTenant>> | null = null;

  beforeAll(async () => {
    app = await createApp();

    tenantA = await createTestTenant(app);
    created.push(tenantA.tenantId);

    // Force distinct tenants by regenerating another fixture
    tenantB = await createTestTenant(app);
    created.push(tenantB.tenantId);
  });

  afterAll(async () => {
    await Promise.all(created.map((tenantId) => cleanupTenant(tenantId)));
    await app.close();
  });

  it("Tenant A token can only read Tenant A data from /api/me/details", async () => {
    expect(tenantA).not.toBeNull();
    expect(tenantB).not.toBeNull();

    const res = await app.inject({
      method: "GET",
      url: "/api/me/details",
      headers: { authorization: `Bearer ${tenantA!.accessToken}` },
    });

    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body) as {
      tenantId: string;
      userId: string;
      email: string;
    };

    expect(body.tenantId).toBe(tenantA!.tenantId);
    expect(body.userId).toBe(tenantA!.userId);
    expect(body.email).toBe(tenantA?.email);

    // Ensure it isn't leaking Tenant B identity.
    expect(body.tenantId).not.toBe(tenantB!.tenantId);
  });

  it("Tenant B token can only read Tenant B data from /api/me/details", async () => {
    expect(tenantA).not.toBeNull();
    expect(tenantB).not.toBeNull();

    const res = await app.inject({
      method: "GET",
      url: "/api/me/details",
      headers: { authorization: `Bearer ${tenantB!.accessToken}` },
    });

    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body) as {
      tenantId: string;
      userId: string;
      email: string;
    };

    expect(body.tenantId).toBe(tenantB!.tenantId);
    expect(body.userId).toBe(tenantB!.userId);
    expect(body.email).toBe(tenantB?.email);

    expect(body.tenantId).not.toBe(tenantA!.tenantId);
  });

  it("Spoofing tenantId via query/headers does not affect DB isolation (trust tenantContext only)", async () => {
    expect(tenantA).not.toBeNull();
    expect(tenantB).not.toBeNull();

    const res = await app.inject({
      method: "GET",
      url: `/api/me/details?tenantId=${encodeURIComponent(tenantB!.tenantId)}`,
      headers: {
        authorization: `Bearer ${tenantA!.accessToken}`,
        "x-tenant-id": tenantB!.tenantId,
      },
    });

    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body) as { tenantId: string; userId: string; email: string };

    // Handler must use request.tenantContext.tenantId (derived from JWT), not query/header.
    expect(body.tenantId).toBe(tenantA!.tenantId);
    expect(body.userId).toBe(tenantA!.userId);
    expect(body.email).toBe(tenantA?.email);
  });

  it("Soft-deleted Tenant should be rejected from /api/me/details (401)", async () => {
    expect(tenantA).not.toBeNull();

    await prisma.tenant.update({
      where: { id: tenantA!.tenantId },
      data: { deletedAt: new Date() },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/me/details",
      headers: { authorization: `Bearer ${tenantA!.accessToken}` },
    });

    expect(res.statusCode).toBe(401);
  });

  it("Soft-deleted User should be rejected from /api/me/details (401)", async () => {
    expect(tenantB).not.toBeNull();

    await prisma.user.update({
      where: { id: tenantB!.userId },
      data: { deletedAt: new Date() },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/me/details",
      headers: { authorization: `Bearer ${tenantB!.accessToken}` },
    });

    expect(res.statusCode).toBe(401);
  });

  it("Soft-deleted Tenant should be rejected from /api/me (401)", async () => {
    expect(tenantA).not.toBeNull();

    const res = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { authorization: `Bearer ${tenantA!.accessToken}` },
    });

    expect(res.statusCode).toBe(401);
  });

  it("Soft-deleted User should be rejected from /api/me (401)", async () => {
    expect(tenantB).not.toBeNull();

    const res = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { authorization: `Bearer ${tenantB!.accessToken}` },
    });

    expect(res.statusCode).toBe(401);
  });

  it("Without JWT, /api/me/details is rejected", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/me/details",
    });

    expect(res.statusCode).toBe(401);
  });
});
