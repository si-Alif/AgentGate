import { describe, it, expect, afterAll } from "vitest";
import { createApp } from "../app.js";
import type { FastifyInstance } from "fastify";

describe("Health Check", () => {
  let app: FastifyInstance;

  afterAll(async () => {
    await app.close();
  });

  it("returns 200 with ok status", async () => {
    app = await createApp();
    const response = await app.inject({
      method: "GET",
      url: "/healthcheck",
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).status).toBe("ok");
    expect(JSON.parse(response.body).timestamp).toBeDefined();
  });

  it("returns 404 for unknown routes", async () => {
    app = await createApp();
    const response = await app.inject({
      method: "GET",
      url: "/this-does-not-exist",
    });

    expect(response.statusCode).toBe(404);
  });
});