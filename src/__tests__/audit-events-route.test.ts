import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createApp } from "../app.js";
import { prisma } from "../lib/prisma.js";
import {
  createTestTenant,
  createTestAgent,
  createTestTool,
  cleanupTenant,
} from "./helpers/test-tenant.factory.js";
import crypto from "node:crypto";

describe("Audit Events Routes", () => {
  let app: Awaited<ReturnType<typeof createApp>>;

  beforeAll(async () => {
    app = await createApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  // ────────────────────────────────────────────────────────────────
  // LIST ENDPOINT
  // ────────────────────────────────────────────────────────────────
  describe("GET /api/audit-events", () => {
    let tenant: Awaited<ReturnType<typeof createTestTenant>>;
    let agent: { id: string };
    let tool: { id: string };
    const seededIds: string[] = [];

    beforeAll(async () => {
      tenant = await createTestTenant(app);
      const agentResult = await createTestAgent(tenant.tenantId, tenant.userId);
      agent = agentResult.agent;
      tool = await createTestTool(tenant.tenantId);

      // Seed 3 invocation events
      for (let i = 0; i < 3; i++) {
        const id = crypto.randomUUID();
        seededIds.push(id);

        await prisma.auditEvent.create({
          data: {
            id,
            tenantId: tenant.tenantId,
            agentId: agent.id,
            toolId: tool.id,
            eventType: "TOOL_INVOCATION",
            status: "success",
            payload: { schemaVersion: 1, query: `test ${i}` },
            createdAt: new Date(Date.now() - i * 1000),
          },
        });

        await prisma.toolExecution.create({
          data: {
            id,
            tenantId: tenant.tenantId,
            toolId: tool.id,
            agentId: agent.id,
            status: "success",
            inputPreview: { query: `test ${i}` },
            outputPreview: "JsonNull",
            inputTruncated: false,
            outputTruncated: false,
            durationMs: i,
            errorCode: null,
            errorMessage: null,
            startedAt: new Date(),
            completedAt: new Date(),
          },
        });
      }
    });

    afterAll(async () => {
      await cleanupTenant(tenant.tenantId);
      
    });

    it("returns a paginated list with lean rows", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/audit-events?limit=2",
        headers: { Authorization: `Bearer ${tenant.accessToken}` },
      });
      expect(res.statusCode).toBe(200);

      const body = JSON.parse(res.body);
      expect(body.data.length).toBe(2);
      expect(body.data[0]).toHaveProperty("hasInputPreview");
      expect(body.data[0]).toHaveProperty("hasOutputPreview");
      expect(body.data[0]).toHaveProperty("schemaVersion");
      expect(body.data[0]).not.toHaveProperty("inputPreview");
      expect(body.data[0]).not.toHaveProperty("outputPreview");
      expect(body.nextCursor).toBeDefined();

      const res2 = await app.inject({
        method: "GET",
        url: `/api/audit-events?limit=2&cursor=${body.nextCursor}`,
        headers: { Authorization: `Bearer ${tenant.accessToken}` },
      });
      expect(res2.statusCode).toBe(200);

      const body2 = JSON.parse(res2.body);
      expect(body2.data.length).toBe(1);
      expect(body2.nextCursor).toBeNull();
    });

    it("rejects an invalid cursor with 400", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/audit-events?cursor=not-valid",
        headers: { Authorization: `Bearer ${tenant.accessToken}` },
      });
      expect(res.statusCode).toBe(400);
    });

    it("filters by eventType", async () => {
      // Seed a non-invocation event
      await prisma.auditEvent.create({
        data: {
          id: crypto.randomUUID(),
          tenantId: tenant.tenantId,
          agentId: agent.id,
          eventType: "AGENT_AUTHENTICATED",
          status: null,
          payload: { schemaVersion: 1 },
          createdAt: new Date(Date.now() - 10 * 1000),
        },
      });

      const res = await app.inject({
        method: "GET",
        url: "/api/audit-events?eventType=TOOL_INVOCATION&limit=10",
        headers: { Authorization: `Bearer ${tenant.accessToken}` },
      });
      expect(res.statusCode).toBe(200);

      const body = JSON.parse(res.body);
      expect(body.data.every((row: any) => row.eventType === "TOOL_INVOCATION")).toBe(true);
    });

    it("caps errorMessage at 200 chars in list view", async () => {
      const id = crypto.randomUUID();
      await prisma.auditEvent.create({
        data: {
          id,
          tenantId: tenant.tenantId,
          agentId: agent.id,
          toolId: tool.id,
          eventType: "TOOL_INVOCATION",
          status: "error",
          payload: { schemaVersion: 1 },
          createdAt: new Date(),
        },
      });
      await prisma.toolExecution.create({
        data: {
          id,
          tenantId: tenant.tenantId,
          toolId: tool.id,
          agentId: agent.id,
          status: "error",
          inputPreview: "JsonNull",
          outputPreview: "JsonNull",
          inputTruncated: false,
          outputTruncated: false,
          durationMs: 0,
          errorCode: "TOOL_ERROR",
          errorMessage: "x".repeat(500),
          startedAt: new Date(),
          completedAt: new Date(),
        },
      });

      const res = await app.inject({
        method: "GET",
        url: "/api/audit-events?limit=10",
        headers: { Authorization: `Bearer ${tenant.accessToken}` },
      });
      expect(res.statusCode).toBe(200);

      const body = JSON.parse(res.body);
      const row = body.data.find((r: any) => r.id === id);
      expect(row).toBeDefined();
      expect(row.errorMessage.length).toBe(200);
    });

    it("enforces tenant isolation on the list", async () => {
      const otherTenant = await createTestTenant(app);
      try {
        const otherAgent = await createTestAgent(otherTenant.tenantId, otherTenant.userId);
        const otherTool = await createTestTool(otherTenant.tenantId);

        await prisma.auditEvent.create({
          data: {
            id: crypto.randomUUID(),
            tenantId: otherTenant.tenantId,
            agentId: otherAgent.agent.id,
            toolId: otherTool.id,
            eventType: "TOOL_INVOCATION",
            status: "success",
            payload: { schemaVersion: 1 },
          },
        });

        const res = await app.inject({
          method: "GET",
          url: "/api/audit-events?limit=10",
          headers: { Authorization: `Bearer ${tenant.accessToken}` },
        });
        expect(res.statusCode).toBe(200);

        const body = JSON.parse(res.body);
        // Our tenant now has 3 initial invocations + 1 AGENT_AUTHENTICATED + 1 error event = 5
        expect(body.data.length).toBe(5);
      } finally {
        await cleanupTenant(otherTenant.tenantId);
      }
    });
    describe("GET /audit-events — `since` filter (Week 7 Day 4)", () => {
      it("GATE — returns only events at or after the given `since` timestamp", async () => {
        const oldEventId = crypto.randomUUID();
        const newEventId = crypto.randomUUID();
        const boundary = new Date("2026-06-15T00:00:00.000Z");

        await prisma.auditEvent.create({
          data: {
            id: oldEventId,
            tenantId: tenant.tenantId,
            agentId: agent.id,
            toolId: tool.id,
            eventType: "TOOL_INVOCATION",
            status: "success",
            payload: { schemaVersion: 1 },
            createdAt: new Date("2026-06-01T00:00:00.000Z"),
          },
        });
        await prisma.auditEvent.create({
          data: {
            id: newEventId,
            tenantId: tenant.tenantId,
            agentId: agent.id,
            toolId: tool.id,
            eventType: "TOOL_INVOCATION",
            status: "success",
            payload: { schemaVersion: 1 },
            createdAt: new Date("2026-07-01T00:00:00.000Z"),
          },
        });

        const res = await app.inject({
          method: "GET",
          // ADDED: limit=10 and encodeURIComponent
          url: `/api/audit-events?limit=10&since=${encodeURIComponent(boundary.toISOString())}`,
          headers: { Authorization: `Bearer ${tenant.accessToken}` },
        });

        expect(res.statusCode).toBe(200);
        const ids = JSON.parse(res.body).data.map((r: any) => r.id);
        expect(ids).toContain(newEventId);
        expect(ids).not.toContain(oldEventId);
      });

      it("an invalid `since` value returns 400, not a silently-ignored filter", async () => {
        const res = await app.inject({
          method: "GET",
          // ADDED: limit=10 here as well to ensure it fails specifically because of `since`
          url: "/api/audit-events?limit=10&since=not-a-real-date",
          headers: { Authorization: `Bearer ${tenant.accessToken}` },
        });

        console.log("FASTIFY 400 ERROR BODY:", res.body);
        expect(res.statusCode).toBe(400);
      });
    });
  });

  // ────────────────────────────────────────────────────────────────
  // DETAIL ENDPOINT
  // ────────────────────────────────────────────────────────────────
  describe("GET /api/audit-events/:id", () => {
    let tenant: Awaited<ReturnType<typeof createTestTenant>>;
    let agent: { id: string };
    let tool: { id: string };
    let invocationEventId: string;
    let nonInvocationEventId: string;

    beforeAll(async () => {
      tenant = await createTestTenant(app);
      const agentResult = await createTestAgent(tenant.tenantId, tenant.userId);
      agent = agentResult.agent;
      tool = await createTestTool(tenant.tenantId);

      // Invocation event with full tool execution
      invocationEventId = crypto.randomUUID();
      await prisma.auditEvent.create({
        data: {
          id: invocationEventId,
          tenantId: tenant.tenantId,
          agentId: agent.id,
          toolId: tool.id,
          eventType: "TOOL_INVOCATION",
          status: "success",
          payload: { schemaVersion: 1, query: "detail-test" },
          createdAt: new Date(),
        },
      });
      await prisma.toolExecution.create({
        data: {
          id: invocationEventId,
          tenantId: tenant.tenantId,
          toolId: tool.id,
          agentId: agent.id,
          status: "success",
          inputPreview: { query: "detail-test" },
          outputPreview: { result: "ok" },
          inputTruncated: false,
          outputTruncated: false,
          durationMs: 42,
          errorCode: null,
          errorMessage: null,
          startedAt: new Date(),
          completedAt: new Date(),
        },
      });

      // Non‑invocation event (no tool execution row)
      nonInvocationEventId = crypto.randomUUID();
      await prisma.auditEvent.create({
        data: {
          id: nonInvocationEventId,
          tenantId: tenant.tenantId,
          agentId: agent.id,
          eventType: "AGENT_AUTHENTICATED",
          status: null,
          payload: { schemaVersion: 1, agent: "test-agent", metadata: { ip: "127.0.0.1" } },
          createdAt: new Date(),
        },
      });
    });

    afterAll(async () => {
      await cleanupTenant(tenant.tenantId);
    });

    it("returns full detail for an invocation event", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/audit-events/${invocationEventId}`,
        headers: { Authorization: `Bearer ${tenant.accessToken}` },
      });
      expect(res.statusCode).toBe(200);

      const body = JSON.parse(res.body);
      expect(body.id).toBe(invocationEventId);
      expect(body.eventType).toBe("TOOL_INVOCATION");
      expect(body.inputPreview).toEqual({ query: "detail-test" });
      expect(body.outputPreview).toEqual({ result: "ok" });
      expect(body.durationMs).toBe(42);
      expect(body.inputTruncated).toBe(false);
      expect(body.outputTruncated).toBe(false);
      expect(body.errorMessage).toBeNull();
      expect(body.schemaVersion).toBe(1);
      expect(body.rawPayload).toBeUndefined();
    });

    it("returns rawPayload for a non-invocation event", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/audit-events/${nonInvocationEventId}`,
        headers: { Authorization: `Bearer ${tenant.accessToken}` },
      });
      expect(res.statusCode).toBe(200);

      const body = JSON.parse(res.body);
      expect(body.id).toBe(nonInvocationEventId);
      expect(body.eventType).toBe("AGENT_AUTHENTICATED");
      expect(body.rawPayload).toBeDefined();
      expect(body.rawPayload.agent).toBe("test-agent");
      expect(body.inputPreview).toBeUndefined();
      expect(body.outputPreview).toBeUndefined();
      expect(body.durationMs).toBeUndefined();
    });

    it("returns 404 for a non-existent audit event", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/audit-events/00000000-0000-0000-0000-000000000000",
        headers: { Authorization: `Bearer ${tenant.accessToken}` },
      });
      expect(res.statusCode).toBe(404);
    });

    it("enforces tenant isolation on detail", async () => {
      const otherTenant = await createTestTenant(app);
      try {
        const res = await app.inject({
          method: "GET",
          url: `/api/audit-events/${invocationEventId}`,
          headers: { Authorization: `Bearer ${otherTenant.accessToken}` },
        });
        expect(res.statusCode).toBe(404);
      } finally {
        await cleanupTenant(otherTenant.tenantId);
      }
    });

    it("caps errorMessage at 4 KB in detail view", async () => {
      const id = crypto.randomUUID();
      const longMessage = "e".repeat(6_000);

      await prisma.auditEvent.create({
        data: {
          id,
          tenantId: tenant.tenantId,
          agentId: agent.id,
          toolId: tool.id,
          eventType: "TOOL_INVOCATION",
          status: "error",
          payload: { schemaVersion: 1 },
          createdAt: new Date(),
        },
      });
      await prisma.toolExecution.create({
        data: {
          id,
          tenantId: tenant.tenantId,
          toolId: tool.id,
          agentId: agent.id,
          status: "error",
          inputPreview: "JsonNull",
          outputPreview: "JsonNull",
          inputTruncated: false,
          outputTruncated: false,
          durationMs: 0,
          errorCode: "TIMEOUT",
          errorMessage: longMessage,
          startedAt: new Date(),
          completedAt: new Date(),
        },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/audit-events/${id}`,
        headers: { Authorization: `Bearer ${tenant.accessToken}` },
      });
      expect(res.statusCode).toBe(200);

      const body = JSON.parse(res.body);
      expect(body.errorMessage.length).toBe(4_000);
    });
  });

  // ────────────────────────────────────────────────────────────────
  // RATE LIMITING
  // ────────────────────────────────────────────────────────────────
  describe("Rate limiting", () => {
    let tenant: Awaited<ReturnType<typeof createTestTenant>>;
    let agent: { id: string };
    let tool: { id: string };
    let eventId: string;

    beforeAll(async () => {
      tenant = await createTestTenant(app);
      const agentResult = await createTestAgent(tenant.tenantId, tenant.userId);
      agent = agentResult.agent;
      tool = await createTestTool(tenant.tenantId);

      eventId = crypto.randomUUID();
      await prisma.auditEvent.create({
        data: {
          id: eventId,
          tenantId: tenant.tenantId,
          agentId: agent.id,
          toolId: tool.id,
          eventType: "TOOL_INVOCATION",
          status: "success",
          payload: { schemaVersion: 1 },
          createdAt: new Date(),
        },
      });
      await prisma.toolExecution.create({
        data: {
          id: eventId,
          tenantId: tenant.tenantId,
          toolId: tool.id,
          agentId: agent.id,
          status: "success",
          inputPreview: "JsonNull",
          outputPreview: "JsonNull",
          inputTruncated: false,
          outputTruncated: false,
          durationMs: 0,
          errorCode: null,
          errorMessage: null,
          startedAt: new Date(),
          completedAt: new Date(),
        },
      });
    });

    afterAll(async () => {
      await cleanupTenant(tenant.tenantId);
    });

    it("returns 429 after 30 requests", async () => {
      // 30 successful requests
      for (let i = 0; i < 30; i++) {
        await app.inject({
          method: "GET",
          url: "/api/audit-events?limit=1",
          headers: { Authorization: `Bearer ${tenant.accessToken}` },
        });
      }
      // 31st should be rate‑limited
      const res = await app.inject({
        method: "GET",
        url: "/api/audit-events?limit=1",
        headers: { Authorization: `Bearer ${tenant.accessToken}` },
      });
      expect(res.statusCode).toBe(429);
    });
  });

});

