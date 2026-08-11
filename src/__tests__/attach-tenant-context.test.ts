import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createApp } from "../app.js";
import { createTestTenant, cleanupTenant } from "./helpers/test-tenant.factory.js";

describe("attachTenantContext — claim validation + tenant integrity", () => {
  let app: Awaited<ReturnType<typeof createApp>>;
  let tenant: Awaited<ReturnType<typeof createTestTenant>> | null = null;

  beforeAll(async () => {
    app = await createApp();
    tenant = await createTestTenant(app);
  });

  afterAll(async () => {
    if (tenant) {
      await cleanupTenant(tenant.tenantId);
    }
    await app.close();
  });

  it("rejects a valid JWT missing tenantId with 401", async () => {
    // Create a token that lacks tenantId claim
    const token = await app.jwt.sign({ userId: "some-user-id", role: "owner" });

    const res = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(401);
  });

  it("rejects a valid JWT missing userId with 401", async () => {
    const token = await app.jwt.sign({ tenantId: "tenant-1", role: "owner" });

    const res = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(401);
  });

  it("rejects a valid JWT missing role with 401", async () => {
    // Sign as any to omit role at runtime (JWT payload is validated in hook)
    const token = await app.jwt.sign({ tenantId: "tenant-1", userId: "user-1" } as any);

    const res = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(401);
  });

  it("rejects a JWT with an invalid role with 401", async () => {
    const token = await app.jwt.sign({
      tenantId: "tenant-1",
      userId: "user-1",
      role: "root",
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(401);
  });

  it("GET /api/me returns tenantContext derived from JWT", async () => {
    expect(tenant).not.toBeNull();

    const res = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { authorization: `Bearer ${tenant!.accessToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      tenantId: tenant!.tenantId,
      userId: tenant!.userId,
      role: "owner",
    });
  });

  it("ignores tenantId from query parameters (does not allow client spoofing)", async () => {
    expect(tenant).not.toBeNull();

    const res = await app.inject({
      method: "GET",
      url: "/api/me?tenantId=tenant-from-query",
      headers: {
        authorization: `Bearer ${tenant!.accessToken}`,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).tenantId).toBe(tenant!.tenantId);
  });

  it("ignores tenantId from headers (does not allow client spoofing)", async () => {
    expect(tenant).not.toBeNull();

    const res = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: {
        authorization: `Bearer ${tenant!.accessToken}`,
        "x-tenant-id": "tenant-from-header",
      },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).tenantId).toBe(tenant!.tenantId);
  });
});
