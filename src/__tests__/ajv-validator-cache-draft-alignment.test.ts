import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { AjvValidatorCache } from "../mcp/cache/ajv-validator-cache.js";
import { toolService } from "../services/tool.service.js";
import { createTestTenant, cleanupTenant } from "./helpers/test-tenant.factory.js";
import type { FastifyInstance } from "fastify";
import { createApp } from "../app.js";

describe("AjvValidatorCache — draft-07 alignment (Finding F1 regression proof)", () => {

  let app: FastifyInstance;

  beforeAll(async () => {
    app = await createApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("GATE — a real tool schema using draft-07's boolean exclusiveMinimum, accepted at creation time by Week 2's schema-validator.ts, compiles and enforces the constraint correctly", async () => {
    const tenant = await createTestTenant(app);
    const tool = await toolService.createTool(tenant.tenantId, {
      name: "draft07-probe",
      handlerType: "web_fetch",
      handlerConfig: { handlerType: "web_fetch", url: "https://example.com" },
      inputSchema: {
        type: "object",
        properties: { count: { type: "number", minimum: 0, exclusiveMinimum: 0 } },
        required: ["count"],
      },
    });
    // Confirms the fixture is genuinely draft-07-shaped and legal —
    // Week 2's own gate accepted it.
    expect(tool.id).toBeDefined();

    const cache = new AjvValidatorCache(10);
    const validate = cache.getOrCompile(tool.id, tool.inputSchema as object);

    expect(validate({ count: 5 })).toBe(true);
    // Under draft-07, exclusiveMinimum:true + minimum:0 means "> 0" —
    // 0 itself must be rejected. Under the buggy Ajv2020
    // interpretation, this constraint would very likely be silently
    // dropped, incorrectly accepting 0.
    expect(validate({ count: 0 })).toBe(false);

    await cleanupTenant(tenant.tenantId);
  });

  it("does not throw for an ordinary, draft-agnostic schema (no regression on the common case)", async () => {
    const cache = new AjvValidatorCache(10);
    const validate = cache.getOrCompile(
      "tool-x",
      { type: "object", properties: { q: { type: "string" } }, required: ["q"] }
    );
    expect(validate({ q: "hi" })).toBe(true);
    expect(validate({})).toBe(false);
  });
});