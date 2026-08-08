import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp } from "../app.js";

vi.mock("../handlers/http-handler.js", () => ({ executeHttpHandler: vi.fn() }));
vi.mock("../handlers/webfetch-handler.js", () => ({ executeWebFetchHandler: vi.fn() }));
vi.mock("../handlers/postgres-handler.js", () => ({ executePostgresHandler: vi.fn() }));

import { executeHttpHandler } from "../handlers/http-handler.js";
import { executeWebFetchHandler } from "../handlers/webfetch-handler.js";
import { executePostgresHandler } from "../handlers/postgres-handler.js";
import { executeTool } from "../lib/execute-tool.js";
import { encryptConfig } from "../lib/encryption.js";
import { prisma } from "../lib/prisma.js";
import { createTestTenant, createTestAgent, createTestTool, cleanupTenant } from "./helpers/test-tenant.factory.js";

const mockedHttp = vi.mocked(executeHttpHandler);
const mockedWebFetch = vi.mocked(executeWebFetchHandler);
const mockedPostgres = vi.mocked(executePostgresHandler);

describe("executeTool — closing the Day 5 coverage gaps", () => {
  let app: FastifyInstance;
  let tenant: Awaited<ReturnType<typeof createTestTenant>>;
  let agentId: string;

  beforeAll(async () => {
    app = await createApp();
    await app.ready();
    tenant = await createTestTenant(app);
    agentId = (await createTestAgent(tenant.tenantId, tenant.userId)).agent.id;
  });

  afterAll(async () => {
    await cleanupTenant(tenant.tenantId);
    await app.close();
  });

  beforeEach(() => {
    mockedHttp.mockReset();
    mockedWebFetch.mockReset();
    mockedPostgres.mockReset();
  });

  describe("errorCode: INVALID_HANDLER_CONFIG (previously untested)", () => {
    it("returns INVALID_HANDLER_CONFIG when the decrypted config no longer satisfies its own handlerType schema", async () => {
      const tool = await createTestTool(tenant.tenantId, {
        name: "invalid-config-probe",
        handlerType: "http",
        handlerConfig: { handlerType: "http", url: "https://example.com", method: "GET" },
        inputSchema: {},
      });

      // A state normal creation could never produce — tool.service.ts's
      // own Zod gate would reject this at write time. Reaching past it
      // proves executeTool()'s OWN defensive re-validation, independent
      // of whether that upstream gate stays airtight.
      const corrupted = encryptConfig(
        JSON.stringify({ handlerType: "http", url: "https://example.com" }), // missing required `method`
        tenant.tenantId
      );
      await prisma.tool.update({ where: { id: tool.id }, data: { handlerConfig: corrupted } });

      const result = await executeTool(tool.id, tenant.tenantId, agentId, {});
      expect(result.status).toBe("error");
      expect(result.errorCode).toBe("INVALID_HANDLER_CONFIG");
    });
  });

  describe("errorCode: UNSUPPORTED_MEDIA_TYPE (previously untested)", () => {
    it("propagates a handler's status:'unsupported_media_type' through to errorCode UNSUPPORTED_MEDIA_TYPE", async () => {
      mockedWebFetch.mockResolvedValue({
        status: "unsupported_media_type",
        error: "Unsupported media type: application/octet-stream",
      });
      const tool = await createTestTool(tenant.tenantId, {
        name: "media-type-probe",
        handlerType: "web_fetch",
        handlerConfig: { handlerType: "web_fetch", url: "https://example.com" },
        inputSchema: {},
      });

      const result = await executeTool(tool.id, tenant.tenantId, agentId, {});
      expect(result.status).toBe("unsupported_media_type");
      expect(result.errorCode).toBe("UNSUPPORTED_MEDIA_TYPE");
    });
  });

  describe("SSRF_BLOCKED classifier boundary — proving it's anchored, not a loose substring match", () => {
    it("classifies a genuine SSRF-blocked message as SSRF_BLOCKED", async () => {
      mockedHttp.mockResolvedValue({ status: "ssrf_blocked", error: "SSRF blocked: evil.example resolves to 127.0.0.1 (loopback)" });
      const tool = await createTestTool(tenant.tenantId, {
        name: "ssrf-classify-probe",
        handlerType: "http",
        handlerConfig: { handlerType: "http", url: "https://example.com", method: "GET" },
        inputSchema: {},
      });
      const result = await executeTool(tool.id, tenant.tenantId, agentId, {});
      expect(result.errorCode).toBe("SSRF_BLOCKED");
    });

    it("does NOT misclassify an unrelated error that merely mentions 'ssrf' in passing (Finding #4)", async () => {
      mockedHttp.mockResolvedValue({
        status: "error",
        error: "Upstream API returned 400: unknown field 'ssrf_policy_id' in request body",
      });
      const tool = await createTestTool(tenant.tenantId, {
        name: "false-positive-probe",
        handlerType: "http",
        handlerConfig: { handlerType: "http", url: "https://example.com", method: "GET" },
        inputSchema: {},
      });
      const result = await executeTool(tool.id, tenant.tenantId, agentId, {});
      // A failure here IS the finding, not a flaky test — it means the
      // classifier uses a broad case-insensitive `.includes("ssrf")`
      // rather than an anchored `.startsWith("SSRF blocked:")` check.
      expect(result.errorCode).toBe("HANDLER_ERROR");
    });
  });

  describe("redaction — proven across HTTP and WebFetch too, not just Postgres", () => {
    it("redacts a credential embedded in an HTTP handler's error message", async () => {
      mockedHttp.mockResolvedValue({ status: "error", error: "connect failed: https://svc:sup3rSecret@internal.example/webhook" });
      const tool = await createTestTool(tenant.tenantId, {
        name: "http-redaction-probe",
        handlerType: "http",
        handlerConfig: { handlerType: "http", url: "https://example.com", method: "GET" },
        inputSchema: {},
      });
      const result = await executeTool(tool.id, tenant.tenantId, agentId, {});
      expect(result.error).not.toContain("sup3rSecret");
    });

    it("redacts a credential embedded in a WebFetch handler's error message", async () => {
      mockedWebFetch.mockResolvedValue({ status: "error", error: "fetch failed: https://svc:sup3rSecret@internal.example/page" });
      const tool = await createTestTool(tenant.tenantId, {
        name: "webfetch-redaction-probe",
        handlerType: "web_fetch",
        handlerConfig: { handlerType: "web_fetch", url: "https://example.com" },
        inputSchema: {},
      });
      const result = await executeTool(tool.id, tenant.tenantId, agentId, {});
      expect(result.error).not.toContain("sup3rSecret");
    });
  });

  describe("unhandled-rejection safety — a REAL (eventually-settling) losing promise", () => {
    it("produces no unhandledRejection when the underlying handler promise rejects AFTER the timeout has already won", async () => {
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => unhandled.push(reason);
      process.on("unhandledRejection", onUnhandled);

      mockedHttp.mockImplementation(
        () => new Promise((_resolve, reject) => setTimeout(() => reject(new Error("late failure")), 300))
      );

      const tool = await createTestTool(tenant.tenantId, {
        name: "late-rejection-probe",
        handlerType: "http",
        handlerConfig: { handlerType: "http", url: "https://example.com", method: "GET" },
        inputSchema: {},
      });

      const result = await executeTool(tool.id, tenant.tenantId, agentId, {}, undefined, 50);
      expect(result.status).toBe("timeout");

      await new Promise((r) => setTimeout(r, 500)); // let the late rejection actually settle

      process.off("unhandledRejection", onUnhandled);
      expect(unhandled).toHaveLength(0);
    });
  });

  describe("concurrency isolation — parallel executeTool() calls never cross-contaminate", () => {
    it("returns each call's own correct result under 10 concurrent invocations across handler types", async () => {
      mockedHttp.mockImplementation(async () => ({ status: "success", result: { marker: "http" } }));
      mockedWebFetch.mockImplementation(async () => ({ status: "success", result: { marker: "webfetch" } }));
      mockedPostgres.mockImplementation(async () => ({ status: "success", result: { marker: "postgres" } }));

      const httpTool = await createTestTool(tenant.tenantId, {
        name: `concurrent-http-${Date.now()}`,
        handlerType: "http",
        handlerConfig: { handlerType: "http", url: "https://example.com", method: "GET" },
        inputSchema: {},
      });
      const webfetchTool = await createTestTool(tenant.tenantId, {
        name: `concurrent-webfetch-${Date.now()}`,
        handlerType: "web_fetch",
        handlerConfig: { handlerType: "web_fetch", url: "https://example.com" },
        inputSchema: {},
      });
      const pgTool = await createTestTool(tenant.tenantId, {
        name: `concurrent-pg-${Date.now()}`,
        handlerType: "postgres",
        handlerConfig: { handlerType: "postgres", connectionString: "postgresql://u:p@internal.invalid:5432/x", query: "SELECT 1" },
        inputSchema: {},
      });

      const calls = [
        ...Array.from({ length: 4 }, () => executeTool(httpTool.id, tenant.tenantId, agentId, {})),
        ...Array.from({ length: 3 }, () => executeTool(webfetchTool.id, tenant.tenantId, agentId, {})),
        ...Array.from({ length: 3 }, () => executeTool(pgTool.id, tenant.tenantId, agentId, {})),
      ];

      const results = await Promise.all(calls);
      expect(results.filter((r) => (r.result as any)?.marker === "http")).toHaveLength(4);
      expect(results.filter((r) => (r.result as any)?.marker === "webfetch")).toHaveLength(3);
      expect(results.filter((r) => (r.result as any)?.marker === "postgres")).toHaveLength(3);
    });
  });
});