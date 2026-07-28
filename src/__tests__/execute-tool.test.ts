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
import { toolService } from "../services/tool.service.js";
import { prisma } from "../lib/prisma.js";
import {
  createTestTenant,
  createTestAgent,
  cleanupTenant,
  createTestTool,
} from "./helpers/test-tenant.factory.js";

const mockedHttp = vi.mocked(executeHttpHandler);
const mockedWebFetch = vi.mocked(executeWebFetchHandler);
const mockedPostgres = vi.mocked(executePostgresHandler);

describe("executeTool", () => {
  let app: FastifyInstance;
  let tenant: Awaited<ReturnType<typeof createTestTenant>>;
  let agentId: string;

  beforeAll(async () => {
    app = await createApp();
    await app.ready();

    tenant = await createTestTenant(app);
    const created = await createTestAgent(tenant.tenantId, tenant.userId);
    agentId = created.agent.id;
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

  describe("tool lookup — before any handler is ever touched", () => {
    it("returns TOOL_NOT_FOUND for a nonexistent id, and calls no handler", async () => {
      const result = await executeTool("nonexistent-id", tenant.tenantId, agentId, {});
      expect(result.errorCode).toBe("TOOL_NOT_FOUND");
      expect(mockedHttp).not.toHaveBeenCalled();
      expect(mockedWebFetch).not.toHaveBeenCalled();
      expect(mockedPostgres).not.toHaveBeenCalled();
    });

    it("existence does not leak across tenants — a real tool under the wrong tenantId reads identically to nonexistent", async () => {
      const otherTenant = await createTestTenant(app);
      const tool = await createTestTool(otherTenant.tenantId, {
        name: "cross-tenant-probe",
        handlerType: "http",
        handlerConfig: { handlerType: "http", url: "https://example.com", method: "GET" },
        inputSchema: {},
      });

      const result = await executeTool(tool.id, tenant.tenantId, agentId, {});
      expect(result.errorCode).toBe("TOOL_NOT_FOUND");

      await cleanupTenant(otherTenant.tenantId);
    });

    it("returns TOOL_INACTIVE for a deactivated tool", async () => {
      const tool = await createTestTool(tenant.tenantId, {
        name: "inactive-probe",
        handlerType: "http",
        handlerConfig: { handlerType: "http", url: "https://example.com", method: "GET" },
        inputSchema: {},
      });
      await toolService.deactivateTool(tool.id, tenant.tenantId);

      const result = await executeTool(tool.id, tenant.tenantId, agentId, {});
      expect(result.errorCode).toBe("TOOL_INACTIVE");
    });
  });

  describe("routing — one handler per handlerType, never the others", () => {
    it("routes an http tool to executeHttpHandler only", async () => {
      mockedHttp.mockResolvedValue({ status: "success", result: { ok: true } });
      const tool = await createTestTool(tenant.tenantId, {
        name: "http-probe",
        handlerType: "http",
        handlerConfig: { handlerType: "http", url: "https://example.com", method: "GET" },
        inputSchema: {},
      });

      const result = await executeTool(tool.id, tenant.tenantId, agentId, { foo: "bar" });

      expect(result.status).toBe("success");
      expect(mockedHttp).toHaveBeenCalledTimes(1);
      expect(mockedWebFetch).not.toHaveBeenCalled();
      expect(mockedPostgres).not.toHaveBeenCalled();
    });

    it("routes a web_fetch tool to executeWebFetchHandler only", async () => {
      mockedWebFetch.mockResolvedValue({ status: "success", result: { text: "hi" } });
      const tool = await createTestTool(tenant.tenantId, {
        name: "webfetch-probe",
        handlerType: "web_fetch",
        handlerConfig: { handlerType: "web_fetch", url: "https://example.com" },
        inputSchema: {},
      });

      const result = await executeTool(tool.id, tenant.tenantId, agentId, {});
      expect(result.status).toBe("success");
      expect(mockedWebFetch).toHaveBeenCalledTimes(1);
      expect(mockedHttp).not.toHaveBeenCalled();
    });

    it("routes a postgres tool to executePostgresHandler only", async () => {
      mockedPostgres.mockResolvedValue({ status: "success", result: { rows: [], rowCount: 0 } });
      const tool = await createTestTool(tenant.tenantId, {
        name: "postgres-probe",
        handlerType: "postgres",
        handlerConfig: {
          handlerType: "postgres",
          connectionString: "postgresql://u:p@internal-db.invalid:5432/x",
          query: "SELECT 1",
        },
        inputSchema: {},
      });

      const result = await executeTool(tool.id, tenant.tenantId, agentId, {});
      expect(result.status).toBe("success");
      expect(mockedPostgres).toHaveBeenCalledTimes(1);
    });
  });

  describe("error classification (classifyHandlerError)", () => {
    async function makeHttpTool() {
      return createTestTool(tenant.tenantId, {
        name: `classify-probe-${Date.now()}`,
        handlerType: "http",
        handlerConfig: { handlerType: "http", url: "https://example.com", method: "GET" },
        inputSchema: {},
      });
    }

    it("maps status:'timeout' to errorCode TIMEOUT", async () => {
      mockedHttp.mockResolvedValue({ status: "timeout", error: "HTTP request timed out" });
      const tool = await makeHttpTool();
      const result = await executeTool(tool.id, tenant.tenantId, agentId, {});
      expect(result.errorCode).toBe("TIMEOUT");
    });

    it("maps status:'payload_too_large' to errorCode PAYLOAD_TOO_LARGE", async () => {
      mockedHttp.mockResolvedValue({ status: "payload_too_large", error: "Response payload exceeded ceiling" });
      const tool = await makeHttpTool();
      const result = await executeTool(tool.id, tenant.tenantId, agentId, {});
      expect(result.errorCode).toBe("PAYLOAD_TOO_LARGE");
    });

    it("maps an SSRF-blocked message to errorCode SSRF_BLOCKED", async () => {
      mockedHttp.mockResolvedValue({
        status: "error",
        error: "SSRF blocked: evil.example resolves to 127.0.0.1 (loopback)",
      });
      const tool = await makeHttpTool();
      const result = await executeTool(tool.id, tenant.tenantId, agentId, {});
      expect(result.errorCode).toBe("SSRF_BLOCKED");
    });

    it("falls back to HANDLER_ERROR for any other status:'error' message", async () => {
      mockedHttp.mockResolvedValue({ status: "error", error: "ECONNREFUSED" });
      const tool = await makeHttpTool();
      const result = await executeTool(tool.id, tenant.tenantId, agentId, {});
      expect(result.errorCode).toBe("HANDLER_ERROR");
    });
  });

  describe("redaction (Decision 5.6)", () => {
    it("strips a credential from the returned error before it reaches the caller", async () => {
      mockedPostgres.mockResolvedValue({
        status: "error",
        error: "connect failed: postgresql://svc:sup3rSecret@10.0.0.5:5432/prod",
      });
      const tool = await createTestTool(tenant.tenantId, {
        name: "redaction-probe",
        handlerType: "postgres",
        handlerConfig: {
          handlerType: "postgres",
          connectionString: "postgresql://u:p@internal-db.invalid:5432/x",
          query: "SELECT 1",
        },
        inputSchema: {},
      });

      const result = await executeTool(tool.id, tenant.tenantId, agentId, {});
      expect(result.error).not.toContain("sup3rSecret");
    });

    it("never redacts .result — only .error", async () => {
      mockedHttp.mockResolvedValue({
        status: "success",
        result: { body: { note: "password=notASecretHere-thisIsOutputData" } },
      });
      const tool = await createTestTool(tenant.tenantId, {
        name: "result-passthrough-probe",
        handlerType: "http",
        handlerConfig: { handlerType: "http", url: "https://example.com", method: "GET" },
        inputSchema: {},
      });

      const result = await executeTool(tool.id, tenant.tenantId, agentId, {});
      expect((result.result as any).body.note).toContain("notASecretHere-thisIsOutputData");
    });
  });

  describe("timeoutMs override — the withTimeout backstop, end to end", () => {
    it("honors an overridden timeoutMs even when the mocked handler hangs forever, in milliseconds not real seconds", async () => {
      mockedHttp.mockImplementation(() => new Promise(() => { })); // never resolves, ignores its own signal
      const tool = await createTestTool(tenant.tenantId, {
        name: "hanging-probe",
        handlerType: "http",
        handlerConfig: { handlerType: "http", url: "https://example.com", method: "GET" },
        inputSchema: {},
      });

      const start = performance.now();
      const result = await executeTool(tool.id, tenant.tenantId, agentId, {}, undefined, 50);
      const elapsed = performance.now() - start;

      expect(result.status).toBe("timeout");
      expect(result.errorCode).toBe("TIMEOUT");
      expect(elapsed).toBeLessThan(2_000);
    });
  });

  describe("decrypt / parse failure paths", () => {
    it("returns DECRYPTION_FAILED when the stored ciphertext is corrupted", async () => {
      const tool = await createTestTool(tenant.tenantId, {
        name: "corrupt-ciphertext-probe",
        handlerType: "http",
        handlerConfig: { handlerType: "http", url: "https://example.com", method: "GET" },
        inputSchema: {},
      });

      // Reach past the service layer deliberately, to force a state
      // that could never occur through normal creation — proves the
      // dispatcher's own decrypt failure path, not the encryption
      // module (already covered in Week 2).
      await prisma.tool.update({
        where: { id: tool.id },
        data: { handlerConfig: "not-a-valid-envelope" },
      });

      const result = await executeTool(tool.id, tenant.tenantId, agentId, {});
      expect(result.errorCode).toBe("DECRYPTION_FAILED");
    });
  });
});