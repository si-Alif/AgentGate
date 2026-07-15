import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp } from "../app.js";
import { prisma } from "../lib/prisma.js";
import { toolService } from "../services/tool.service.js";
import { agentService } from "../services/agent.service.js";
import { toolRepository } from "../repositories/tool.repository.js";
import { createTestTenant, cleanupTenant } from "./helpers/test-tenant.factory.js";

describe("Week 2 — Day 6 Integration Proof Checkpoint (Agents + Tools)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await createApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function createTestTool(tenantId: string) {
    return toolService.createTool(tenantId, {
      name: `tool-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      handlerType: "web_fetch",
      handlerConfig: { handlerType: "web_fetch", url: "https://example.com" },
      inputSchema: { type: "object", properties: {} },
    });
  }

  // ────────────────────────────────────────────────────────────────
  // GATE 1 — Encryption: ciphertext-not-plaintext + roundtrip
  // ────────────────────────────────────────────────────────────────
  describe("GATE 1 — Encryption", () => {
    it("stores handler_config as ciphertext, not plaintext, and round-trips via the service", async () => {
      const tenant = await createTestTenant(app);
      try {
        const secretConnectionString =
          "postgresql://prod-user:s3cr3t@db.internal.example.com:5432/prod";

        const tool = await toolService.createTool(tenant.tenantId, {
          name: "internal-db-query",
          handlerType: "postgres",
          handlerConfig: {
            handlerType: "postgres",
            connectionString: secretConnectionString,
            query: "SELECT 1",
          },
          inputSchema: { type: "object", properties: {} },
        });

        const rawRow = await prisma.tool.findUniqueOrThrow({ where: { id: tool.id } });
        expect(rawRow.handlerConfig).not.toContain(secretConnectionString);
        expect(rawRow.handlerConfig).not.toContain("s3cr3t");
        expect(rawRow.handlerConfig.split(":")).toHaveLength(3);

        const decrypted = await toolService.getDecryptedConfig(tool.id, tenant.tenantId);
        expect(decrypted?.connectionString).toBe(secretConnectionString);
      } finally {
        await cleanupTenant(tenant.tenantId);
      }
    });

    it("public tool shape never leaks handler_config in any form", async () => {
      const tenant = await createTestTenant(app);
      try {
        const created = await toolService.createTool(tenant.tenantId, {
          name: "leak-check-tool",
          handlerType: "postgres",
          handlerConfig: {
            handlerType: "postgres",
            connectionString: "postgresql://user:topsecret@db.example.com:5432/prod",
            query: "SELECT 1",
          },
          inputSchema: { type: "object", properties: {} },
        });

        expect(created).not.toHaveProperty("handlerConfig");
        expect(JSON.stringify(created)).not.toContain("topsecret");

        const fetched = await toolService.getTool(created.id, tenant.tenantId);
        expect(fetched).not.toHaveProperty("handlerConfig");
        expect(JSON.stringify(fetched)).not.toContain("topsecret");

        const listed = await toolService.listTools(tenant.tenantId);
        for (const item of listed) {
          expect(item).not.toHaveProperty("handlerConfig");
        }
        expect(JSON.stringify(listed)).not.toContain("topsecret");
      } finally {
        await cleanupTenant(tenant.tenantId);
      }
    });
  });

  // ────────────────────────────────────────────────────────────────
  // GATE 2 — API Keys: raw key shown exactly once
  // ────────────────────────────────────────────────────────────────
  describe("GATE 2 — API Keys", () => {
    it("returns the raw API key exactly once; it is never retrievable again", async () => {
      const tenant = await createTestTenant(app);
      try {
        const created = await agentService.createAgent(tenant.tenantId, tenant.userId, {
          name: "billing-agent",
        });

        expect(created.apiKey).toMatch(/^agk\./);

        const fetched = await agentService.getAgent(created.agent.id, tenant.tenantId);
        expect(JSON.stringify(fetched)).not.toContain(created.apiKey);

        const rawRow = await prisma.agent.findUniqueOrThrow({ where: { id: created.agent.id } });
        expect(rawRow.apiKeyHash).not.toBe(created.apiKey);
        expect(rawRow.apiKeyHash.startsWith("$argon2")).toBe(true);

        const listed = await agentService.listAgents(tenant.tenantId);
        expect(JSON.stringify(listed)).not.toContain(created.apiKey);
      } finally {
        await cleanupTenant(tenant.tenantId);
      }
    });
  });

  // ────────────────────────────────────────────────────────────────
  // GATE 3 — Repository bug regression: setActiveStatus must target `tool`
  // ────────────────────────────────────────────────────────────────
  describe("GATE 3 — Repository Bug Regression", () => {
    it("setActiveStatus deactivates the TOOL row (not agent)", async () => {
      const tenant = await createTestTenant(app);
      try {
        const tool = await createTestTool(tenant.tenantId);

        const { count } = await toolRepository.setActiveStatus(tool.id, tenant.tenantId, false);
        expect(count).toBe(1);

        const updated = await prisma.tool.findUniqueOrThrow({ where: { id: tool.id } });
        expect(updated.isActive).toBe(false);
      } finally {
        await cleanupTenant(tenant.tenantId);
      }
    });

    it("deactivateTool() end-to-end reflects the same fix through the service layer", async () => {
      const tenant = await createTestTenant(app);
      try {
        const tool = await createTestTool(tenant.tenantId);

        const result = await toolService.deactivateTool(tool.id, tenant.tenantId);
        expect(result).toBe(true);

        const fetched = await toolService.getTool(tool.id, tenant.tenantId);
        expect(fetched?.isActive).toBe(false);
      } finally {
        await cleanupTenant(tenant.tenantId);
      }
    });
  });

  // ────────────────────────────────────────────────────────────────
  // GATE 4 — handlerType single-source-of-truth
  // ────────────────────────────────────────────────────────────────
  describe("GATE 4 — handlerType Single-Source-of-Truth", () => {
    it("rejects a handlerConfig whose inner handlerType disagrees with the outer field", async () => {
      const tenant = await createTestTenant(app);
      try {
        await expect(
          toolService.createTool(tenant.tenantId, {
            name: "confused-tool",
            handlerType: "web_fetch",
            handlerConfig: {
              handlerType: "postgres",
              connectionString: "postgresql://user:pass@db.example.com/prod",
              query: "SELECT 1",
            },
            inputSchema: { type: "object", properties: {} },
          })
        ).rejects.toThrow();
      } finally {
        await cleanupTenant(tenant.tenantId);
      }
    });

    it("persisted handlerType matches decrypted handler_config's handlerType", async () => {
      const tenant = await createTestTenant(app);
      try {
        const tool = await toolService.createTool(tenant.tenantId, {
          name: "consistent-tool",
          handlerType: "web_fetch",
          handlerConfig: { handlerType: "web_fetch", url: "https://example.com" },
          inputSchema: { type: "object", properties: {} },
        });

        const rawRow = await prisma.tool.findUniqueOrThrow({ where: { id: tool.id } });
        const decrypted = await toolService.getDecryptedConfig(tool.id, tenant.tenantId);

        expect(rawRow.handlerType).toBe("web_fetch");
        expect(decrypted?.handlerType).toBe(rawRow.handlerType);
      } finally {
        await cleanupTenant(tenant.tenantId);
      }
    });
  });

  // ────────────────────────────────────────────────────────────────
  // GATE 5 — SSRF pre-filter integration (Layer 1)
  // ────────────────────────────────────────────────────────────────
  describe("GATE 5 — SSRF Pre-Filter — Integration", () => {
    it("rejects tool creation targeting cloud metadata infrastructure", async () => {
      const tenant = await createTestTenant(app);
      try {
        await expect(
          toolService.createTool(tenant.tenantId, {
            name: "internal-target",
            handlerType: "http",
            handlerConfig: {
              handlerType: "http",
              url: "http://169.254.169.254/",
              method: "GET",
            },
            inputSchema: { type: "object", properties: {} },
          })
        ).rejects.toThrow();
      } finally {
        await cleanupTenant(tenant.tenantId);
      }
    });

    it("rejects postgres handler_config targeting loopback", async () => {
      const tenant = await createTestTenant(app);
      try {
        await expect(
          toolService.createTool(tenant.tenantId, {
            name: "loopback-db",
            handlerType: "postgres",
            handlerConfig: {
              handlerType: "postgres",
              connectionString: "postgresql://user@127.0.0.1:5432/db",
              query: "SELECT 1",
            },
            inputSchema: { type: "object", properties: {} },
          })
        ).rejects.toThrow();
      } finally {
        await cleanupTenant(tenant.tenantId);
      }
    });

    it("allows a legitimate external target through (false-positive check)", async () => {
      const tenant = await createTestTenant(app);
      try {
        const tool = await toolService.createTool(tenant.tenantId, {
          name: "legit-webhook",
          handlerType: "http",
          handlerConfig: {
            handlerType: "http",
            url: "https://api.stripe.com/v1/charges",
            method: "GET",
          },
          inputSchema: { type: "object", properties: {} },
        });
        expect(tool.id).toBeDefined();
      } finally {
        await cleanupTenant(tenant.tenantId);
      }
    });
  });

  // ────────────────────────────────────────────────────────────────
  // GATE 6 — ReDoS pattern gate integration
  // ────────────────────────────────────────────────────────────────
  describe("GATE 6 — ReDoS Pattern Gate — Integration", () => {
    it("rejects tool creation with an unsafe input_schema pattern", async () => {
      const tenant = await createTestTenant(app);
      try {
        await expect(
          toolService.createTool(tenant.tenantId, {
            name: "redos-tool",
            handlerType: "web_fetch",
            handlerConfig: { handlerType: "web_fetch", url: "https://example.com" },
            inputSchema: { type: "object", properties: { x: { type: "string", pattern: "^(a+)+$" } } },
          })
        ).rejects.toMatchObject({ code: "UNSAFE_SCHEMA_PATTERN" });
      } finally {
        await cleanupTenant(tenant.tenantId);
      }
    });

    it("does NOT reject legitimate, realistic input schemas (false-positive check)", async () => {
      const tenant = await createTestTenant(app);
      try {
        const tool = await toolService.createTool(tenant.tenantId, {
          name: "email-validator-tool",
          handlerType: "web_fetch",
          handlerConfig: { handlerType: "web_fetch", url: "https://example.com" },
          inputSchema: {
            type: "object",
            properties: {
              email: {
                type: "string",
                pattern: "^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$",
              },
            },
          },
        });
        expect(tool.id).toBeDefined();
      } finally {
        await cleanupTenant(tenant.tenantId);
      }
    });

    it("distinguishes the three failure gates via ValidationError.code", async () => {
      const tenant = await createTestTenant(app);
      try {
        await expect(
          toolService.createTool(tenant.tenantId, {
            name: "bad-structural",
            handlerType: "web_fetch",
            handlerConfig: { handlerType: "web_fetch", url: "https://example.com" },
            inputSchema: { type: "not-a-real-type" },
          })
        ).rejects.toMatchObject({ code: "INVALID_INPUT_SCHEMA" });

        let deep: unknown = { type: "string" };
        for (let i = 0; i < 25; i++) {
          deep = { type: "object", properties: { nested: deep } };
        }

        await expect(
          toolService.createTool(tenant.tenantId, {
            name: "bad-complexity",
            handlerType: "web_fetch",
            handlerConfig: { handlerType: "web_fetch", url: "https://example.com" },
            inputSchema: deep,
          })
        ).rejects.toMatchObject({ code: "INVALID_TOO_COMPLEX" });

        await expect(
          toolService.createTool(tenant.tenantId, {
            name: "bad-pattern",
            handlerType: "web_fetch",
            handlerConfig: { handlerType: "web_fetch", url: "https://example.com" },
            inputSchema: { type: "object", properties: { x: { type: "string", pattern: "^(a+)+$" } } },
          })
        ).rejects.toMatchObject({ code: "UNSAFE_SCHEMA_PATTERN" });
      } finally {
        await cleanupTenant(tenant.tenantId);
      }
    });
  });
});
