import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createApp } from "../app.js";

describe("attachTenantContext — claim validation", () => {
  let app: Awaited<ReturnType<typeof createApp>>;

  beforeAll(async () => {
    app = await createApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it("rejects a valid JWT missing tenantId with 401", async () => {
    // Create a token that lacks tenantId claim
    const token = await app.jwt.sign({ userId: "some-user-id", role: "owner" });

    const res = await app.inject({
      method: "GET",
      url: "/api/ping",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(401);
  });
});
