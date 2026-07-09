import { describe, it, expect, afterAll } from "vitest";
import { createApp } from "../app.js";
import { cleanupTenant } from "./helpers/test-tenant.factory.js"; // adjust path/name

describe("Registration edge cases", () => {
  let app: Awaited<ReturnType<typeof createApp>>;
  let createdTenantId: string | undefined;

  afterAll(async () => {
    if (createdTenantId) await cleanupTenant(createdTenantId);
    await app.close();
  });

  it("duplicate email across different slugs returns a clean 409, not a 500", async () => {
    app = await createApp();
    const email = `dup-${Date.now()}@example.com`;

    const first = await app.inject({
      method: "POST",
      url: "/auth/register-tenant",
      payload: { tenantName: "First", slug: `dup-a-${Date.now()}`, ownerEmail: email, password: "Password123!" },
    });
    expect(first.statusCode).toBe(201);
    createdTenantId = JSON.parse(first.body).tenant.id;

    const second = await app.inject({
      method: "POST",
      url: "/auth/register-tenant",
      payload: { tenantName: "Second", slug: `dup-b-${Date.now()}`, ownerEmail: email, password: "Password123!" },
    });

    // Before Fix #4: this currently returns 500 with a raw Prisma message.
    // After Fix #4: should be a clean 409.
    expect(second.statusCode).toBe(409);
    expect(JSON.parse(second.body).message).not.toMatch(/prisma/i);
  });
});