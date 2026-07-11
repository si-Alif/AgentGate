import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp } from "../app.js";
import { prisma } from "../lib/prisma.js";
import { createTestTenant, cleanupTenant } from "./helpers/test-tenant.factory.js";

let app: FastifyInstance;

beforeAll(async () => {
  app = await createApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

// Uses the token the factory already obtained via a real
// register -> verify -> login cycle, rather than hand-signing a
// second token that could drift from what /auth/login actually
// encodes in the JWT payload.
function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

describe("Agent CRUD (Week 2 / Day 2)", () => {
  it("creates an agent and returns the raw API key exactly once", async () => {
    const tenant = await createTestTenant(app);

    const res = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: bearer(tenant.accessToken),
      payload: { name: "billing-agent", description: "Reads invoice status" },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.apiKey).toMatch(/^agk\./);
    expect(body.agent.name).toBe("billing-agent");

    await cleanupTenant(tenant.tenantId);
  });

  it("raw API key is absent from the agent object itself", async () => {
    const tenant = await createTestTenant(app);

    const res = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: bearer(tenant.accessToken),
      payload: { name: "no-leak-agent" },
    });

    const body = res.json();
    expect(JSON.stringify(body.agent)).not.toContain(body.apiKey);
    expect(body.agent).not.toHaveProperty("apiKeyHash");
    expect(body.agent).not.toHaveProperty("apiKeyId");

    await cleanupTenant(tenant.tenantId);
  });

  it("raw API key never reappears on a subsequent GET /api/agents/:id", async () => {
    const tenant = await createTestTenant(app);
    const headers = bearer(tenant.accessToken);

    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers,
      payload: { name: "fetch-me-later" },
    });
    const { agent, apiKey } = created.json();

    const fetched = await app.inject({ method: "GET", url: `/api/agents/${agent.id}`, headers });

    expect(fetched.statusCode).toBe(200);
    expect(JSON.stringify(fetched.json())).not.toContain(apiKey);

    await cleanupTenant(tenant.tenantId);
  });

  it("stores an argon2 hash — not the plaintext secret — in api_key_hash", async () => {
    const tenant = await createTestTenant(app);

    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: bearer(tenant.accessToken),
      payload: { name: "hash-check-agent" },
    });
    const { agent, apiKey } = created.json();

    const rawRow = await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } });
    expect(rawRow.apiKeyHash).not.toBe(apiKey);
    expect(rawRow.apiKeyHash.startsWith("$argon2")).toBe(true);

    await cleanupTenant(tenant.tenantId);
  });

  it("returns 409 when creating a second agent with the same name in the same tenant", async () => {
    const tenant = await createTestTenant(app);
    const headers = bearer(tenant.accessToken);

    await app.inject({ method: "POST", url: "/api/agents", headers, payload: { name: "dup-agent" } });
    const second = await app.inject({ method: "POST", url: "/api/agents", headers, payload: { name: "dup-agent" } });

    expect(second.statusCode).toBe(409);

    await cleanupTenant(tenant.tenantId);
  });

  it("returns 404 for GET /api/agents/:id on a nonexistent id", async () => {
    const tenant = await createTestTenant(app);

    const res = await app.inject({
      method: "GET",
      url: "/api/agents/00000000-0000-0000-0000-000000000000",
      headers: bearer(tenant.accessToken),
    });

    expect(res.statusCode).toBe(404);

    await cleanupTenant(tenant.tenantId);
  });

  it("PATCH updates name/description", async () => {
    const tenant = await createTestTenant(app);
    const headers = bearer(tenant.accessToken);

    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers,
      payload: { name: "patch-me", description: "before" },
    });
    const { agent } = created.json();

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/agents/${agent.id}`,
      headers,
      payload: { description: "after" },
    });

    expect(patched.statusCode).toBe(200);
    expect(patched.json().description).toBe("after");

    await cleanupTenant(tenant.tenantId);
  });

  it("PATCH rejects an isActive field outright (additionalProperties: false)", async () => {
    const tenant = await createTestTenant(app);
    const headers = bearer(tenant.accessToken);

    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers,
      payload: { name: "no-sneaky-reactivate" },
    });
    const { agent } = created.json();

    await app.inject({ method: "DELETE", url: `/api/agents/${agent.id}`, headers });

    const sneaky = await app.inject({
      method: "PATCH",
      url: `/api/agents/${agent.id}`,
      headers,
      payload: { name: "still-deactivated", isActive: true },
    });

    // additionalProperties: false means this must be a clean 400 —
    // not a 200 that silently drops the field.
    expect(sneaky.statusCode).toBe(400);

    const rawRow = await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } });
    expect(rawRow.isActive).toBe(false);

    await cleanupTenant(tenant.tenantId);
  });

  it("DELETE deactivates (isActive=false) rather than removing the row", async () => {
    const tenant = await createTestTenant(app);
    const headers = bearer(tenant.accessToken);

    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers,
      payload: { name: "delete-me" },
    });
    const { agent } = created.json();

    const deleted = await app.inject({ method: "DELETE", url: `/api/agents/${agent.id}`, headers });
    expect(deleted.statusCode).toBe(204);

    const rawRow = await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } });
    expect(rawRow).not.toBeNull();
    expect(rawRow.isActive).toBe(false);

    await cleanupTenant(tenant.tenantId);
  });

  it("reactivate flips isActive back to true and returns the full agent object", async () => {
    const tenant = await createTestTenant(app);
    const headers = bearer(tenant.accessToken);

    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers,
      payload: { name: "reactivate-me" },
    });
    const { agent } = created.json();

    await app.inject({ method: "DELETE", url: `/api/agents/${agent.id}`, headers });
    const reactivated = await app.inject({ method: "POST", url: `/api/agents/${agent.id}/reactivate`, headers });

    // Regression guard: this used to receive `true`/`false` instead
    // of an agent object (reactivateAgent's old boolean-return bug).
    expect(reactivated.statusCode).toBe(200);
    const body = reactivated.json();
    expect(body.id).toBe(agent.id);
    expect(body.isActive).toBe(true);

    await cleanupTenant(tenant.tenantId);
  });

  it("rotate-key issues a new key and invalidates the old one", async () => {
    const tenant = await createTestTenant(app);
    const headers = bearer(tenant.accessToken);

    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers,
      payload: { name: "rotate-me" },
    });
    const { agent } = created.json();

    const before = await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } });

    const rotated = await app.inject({ method: "POST", url: `/api/agents/${agent.id}/rotate-key`, headers });
    expect(rotated.statusCode).toBe(200);
    const { apiKey: newKey } = rotated.json();
    expect(newKey).toMatch(/^agk\./);

    const after = await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } });
    expect(after.apiKeyId).not.toBe(before.apiKeyId);
    expect(after.apiKeyHash).not.toBe(before.apiKeyHash);

    await cleanupTenant(tenant.tenantId);
  });

  it("returns 400 when name is missing or too short", async () => {
    const tenant = await createTestTenant(app);
    const headers = bearer(tenant.accessToken);

    const missing = await app.inject({ method: "POST", url: "/api/agents", headers, payload: {} });
    expect(missing.statusCode).toBe(400);

    const empty = await app.inject({ method: "POST", url: "/api/agents", headers, payload: { name: "" } });
    expect(empty.statusCode).toBe(400);

    await cleanupTenant(tenant.tenantId);
  });

  it("handles an agent created without a description without crashing serialization", async () => {
    const tenant = await createTestTenant(app);

    const res = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: bearer(tenant.accessToken),
      payload: { name: "no-description-agent" },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().agent.description).toBeNull();

    await cleanupTenant(tenant.tenantId);
  });
});