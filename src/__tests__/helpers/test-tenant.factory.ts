import type { FastifyInstance } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { agentService } from "../../services/agent.service.js";
import { toolService } from "../../services/tool.service.js";
import { permissionRepository } from "../../repositories/permission.repository.js";

export interface TestTenantHandle {
  tenantId: string;
  userId: string;
  email: string;
  accessToken: string;
  refreshToken: string;
}

/**
 * Registers a fully verified tenant + owner + logs them in.
 * Returns everything a downstream test needs, and the caller
 * is responsible for passing tenantId to `cleanupTenant`.
 *
 * Centralizing this now means Week 2's agent/tool tests, Week 3's
 * permission tests, and Week 6's MCP client tests all provision
 * their fixture tenant identically — no drift between spec files.
 */
export async function createTestTenant(
  app: FastifyInstance,
  opts: { password?: string } = {}
): Promise<TestTenantHandle> {
  const password = opts.password ?? "StrongPass123!";
  const slug = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `owner-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.local`;

  const regRes = await app.inject({
    method: "POST",
    url: "/auth/register-tenant",
    payload: { tenantName: "Test Co", slug, ownerEmail: email, password },
  });
  if (regRes.statusCode !== 201) {
    throw new Error(`createTestTenant: registration failed (${regRes.statusCode}): ${regRes.body}`);
  }

  const user = await prisma.user.findUniqueOrThrow({ where: { email } });

  const verifyRes = await app.inject({
    method: "GET",
    url: `/auth/verify-email?token=${user.verificationToken}`,
  });
  if (verifyRes.statusCode !== 200) {
    throw new Error(`createTestTenant: verify-email failed (${verifyRes.statusCode}): ${verifyRes.body}`);
  }

  const loginRes = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { email, password },
  });
  if (loginRes.statusCode !== 200) {
    throw new Error(`createTestTenant: login failed (${loginRes.statusCode}): ${loginRes.body}`);
  }

  const { accessToken, refreshToken } = loginRes.json() as {
    accessToken: string;
    refreshToken: string;
  };

  return { tenantId: user.tenantId, userId: user.id, email, accessToken, refreshToken };
}

/**
 * Scoped teardown — deletes exactly the tenant this test created,
 * via cascade, and NOTHING else. Safe to call in serialized OR
 * (future) parallel execution, unlike a blanket deleteMany().
 *
 * Cascade (onDelete: Cascade) handles agents/tools/permissions
 * automatically. This function does not need to change as new
 * entity types are added — including Week 5's tool_executions /
 * audit_events once those tables land, as long as they too hang
 * off tenantId by FK.
 */
export async function cleanupTenant(tenantId: string): Promise<void> {
  await prisma.tenant.delete({ where: { id: tenantId } }).catch((err) => {
    // Already deleted by a prior assertion path (e.g. a test that
    // explicitly deletes as part of what it's proving) — not an error.
    if (err.code !== "P2025") throw err;
  });
}

// ═══════════════════════════════════════════════════════════════
// AGENT FIXTURES
// ═══════════════════════════════════════════════════════════════

export interface TestAgentOverrides {
  name?: string;
  description?: string;
}

/**
 * INTEGRATION-TIER fixture — creates an agent via the SERVICE layer,
 * bypassing the HTTP route / JWT-middleware chain entirely.
 *
 * Use this in:
 *  - repository tests (permission.repository.test.ts, agent.repository tests)
 *  - service/engine tests (checkPermission, checkRateLimit, etc.)
 *  - any test whose subject is NOT the HTTP route layer itself
 *
 * Do NOT reach for createTestAgentViaApi below "just to be safe" in
 * these cases — routing a repository test through HTTP means a
 * route-registration bug or an auth-middleware regression can fail
 * a test that has nothing to do with either. Keep the failure signal
 * narrow to the layer actually under test.
 *
 * Returns the exact shape agentService.createAgent returns:
 * { agent: PublicAgent, apiKey: string }. The apiKey is kept in the
 * return value (not stripped) because Week 6's MCP client gateway
 * tests need a real, valid raw key to connect with — most Week 3
 * callers will only destructure `.agent` and that's fine.
 */
export interface TestAgentCreationResult{
  agent: {
    id: string;
    tenantId: string;
    name: string;
    description: string | null;
    isActive: boolean;
    createdBy: string;
    createdAt: Date;
    updatedAt: Date;
    lastActiveAt: Date | null;
  };
  apiKey: string;
}


export async function createTestAgent(
  tenantId: string,
  createdBy: string,
  overrides: TestAgentOverrides = {}
) {
  const input: { name: string; description?: string } = {
    name: overrides.name ?? `test-agent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  };
  if (overrides.description !== undefined) {
    input.description = overrides.description;
  }
  return agentService.createAgent(tenantId, createdBy, input);
}

/**
 * E2E-TIER fixture — creates an agent via a real HTTP POST through
 * app.inject(), exercising the full route -> authenticate ->
 * attachTenantContext -> requireActiveIdentity -> service ->
 * repository chain.
 *
 * Reserve this for genuine end-to-end tests (your `.e2e.` naming
 * convention) that are specifically proving the ROUTE is wired
 * correctly — request schema validation, auth enforcement, response
 * shape. Everything else should prefer createTestAgent() above: it's
 * faster (no JSON-Schema validation / JWT verify overhead per call)
 * and narrower in what it can fail on.
 *
 * NOTE the path is "/api/agents" — matching the actual registration
 * in app.ts (`scope.register(agentRoutes, { prefix: "/api/agents" })`),
 * not "/agents". This is exactly the bug this consolidation removes:
 * the prefix now only has to be correct in one place.
 */
export async function createTestAgentViaApi(
  app: FastifyInstance,
  accessToken: string,
  overrides: TestAgentOverrides = {}
) {
  const res = await app.inject({
    method: "POST",
    url: "/api/agents",
    headers: { Authorization: `Bearer ${accessToken}` },
    payload: {
      name: overrides.name ?? `test-agent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      description: overrides.description,
    },
  });

  if (res.statusCode !== 201) {
    throw new Error(`createTestAgentViaApi: agent creation failed (${res.statusCode}): ${res.body}`);
  }

  return res.json() as { agent: { id: string; tenantId: string; name: string;[k: string]: unknown }; apiKey: string };
}

// ═══════════════════════════════════════════════════════════════
// TOOL FIXTURES
// ═══════════════════════════════════════════════════════════════

export type TestToolHandlerType = "http" | "postgres" | "web_fetch";

export interface TestToolOverrides {
  name?: string;
  description?: string;
  category?: string;
  handlerType?: TestToolHandlerType;
  handlerConfig?: Record<string, unknown>;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

/**
 * One safe default handlerConfig per handlerType. Centralized here
 * so three different test files stop each improvising a slightly
 * different "trivial tool" — which is exactly how one of them
 * eventually drifts into something that accidentally trips the
 * SSRF pre-filter or the ReDoS pattern gate (Week 2 Gates 5 & 6).
 *
 * All three targets are known-safe, non-resolving-dependent hosts
 * already proven to pass tool-creation-time validation in the
 * existing Week 2 integration suite (they don't require live DNS
 * resolution to succeed — that's a Week 4 connection-time concern,
 * not a creation-time one).
 */
const DEFAULT_HANDLER_CONFIGS: Record<TestToolHandlerType, Record<string, unknown>> = {
  web_fetch: { handlerType: "web_fetch", url: "https://example.com" },
  http: { handlerType: "http", url: "https://example.com/webhook", method: "GET" },
  postgres: {
    handlerType: "postgres",
    connectionString: "postgresql://user:pass@db.example.com:5432/testdb",
    query: "SELECT 1",
  },
};

/**
 * INTEGRATION-TIER fixture — creates a tool via the SERVICE layer.
 *
 * Defaults to `web_fetch` with an empty input_schema — the cheapest
 * combination that clears validation with zero domain-specific setup.
 *
 * FORWARD COMPATIBILITY (Week 4): the executor's handler-isolation
 * tests need tools whose handlerConfig points at a target that's
 * actually mocked (`nock` for http, `pg-mock` for postgres,
 * `fetchMock` for web_fetch) rather than a real example.com. Don't
 * add new parameters to this function for that — pass a full
 * `handlerConfig` override instead, e.g.:
 *
 *   createTestTool(tenantId, {
 *     handlerType: "http",
 *     handlerConfig: { handlerType: "http", url: "http://mock-target.test/webhook", method: "POST" },
 *   })
 *
 * The override slot already covers every future handler-shape need
 * without another signature change.
 */

export interface TestToolInterface {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  handlerType: string;
  inputSchema: unknown;
  outputSchema: unknown;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export async function createTestTool(tenantId: string, overrides: TestToolOverrides = {}) : Promise<TestToolInterface> {
  const handlerType = overrides.handlerType ?? "web_fetch";
  const handlerConfig = overrides.handlerConfig ?? DEFAULT_HANDLER_CONFIGS[handlerType];

  const input: {
    name: string;
    description?: string;
    category?: string;
    handlerType: string;
    handlerConfig: unknown;
    inputSchema: unknown;
    outputSchema?: unknown;
  } = {
    name: overrides.name ?? `test-tool-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    handlerType,
    handlerConfig,
    inputSchema: overrides.inputSchema ?? { type: "object", properties: {} },
  };
  if (overrides.description !== undefined) input.description = overrides.description;
  if (overrides.category !== undefined) input.category = overrides.category;
  if (overrides.outputSchema !== undefined) input.outputSchema = overrides.outputSchema;

  return toolService.createTool(tenantId, input);
}

/**
 * E2E-TIER fixture — creates a tool via a real HTTP POST.
 * Same rationale as createTestAgentViaApi: reserve for tests
 * specifically proving /api/tools route wiring, not general setup.
 */
export async function createTestToolViaApi(
  app: FastifyInstance,
  accessToken: string,
  overrides: TestToolOverrides = {}
) {
  const handlerType = overrides.handlerType ?? "web_fetch";
  const handlerConfig = overrides.handlerConfig ?? DEFAULT_HANDLER_CONFIGS[handlerType];

  const res = await app.inject({
    method: "POST",
    url: "/api/tools",
    headers: { Authorization: `Bearer ${accessToken}` },
    payload: {
      name: overrides.name ?? `test-tool-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      description: overrides.description,
      category: overrides.category,
      handlerType,
      handlerConfig,
      inputSchema: overrides.inputSchema ?? { type: "object", properties: {} },
      outputSchema: overrides.outputSchema,
    },
  });

  if (res.statusCode !== 201) {
    throw new Error(`createTestToolViaApi: tool creation failed (${res.statusCode}): ${res.body}`);
  }

  return res.json();
}

// ═══════════════════════════════════════════════════════════════
// COMPOSITE FIXTURE (optional convenience — see note below)
// ═══════════════════════════════════════════════════════════════

/**
 * Provisions an agent + a tool + an active permission grant between
 * them in one call. Purely a convenience wrapper around the three
 * fixtures above — introduces no new creation logic of its own.
 *
 * Justified by repetition, not just convenience: Week 3's Day 1/2/6
 * tests, Week 4's checkPermission-gated executor tests, and Week 6's
 * MCP client tests all need this exact triple as setup noise before
 * the actual assertion. Without this, that triple gets typed out by
 * hand in a dozen more test files across four more weeks.
 *
 * Trade-off worth naming: this introduces a dependency from a
 * tenant/agent/tool fixture file onto permissionRepository (a Week 3
 * module). If that feels like the wrong layering to you, it's
 * reasonable to instead keep this OUT of test-tenant.factory.ts and
 * put it in a separate `permission-fixtures.ts` under the same
 * helpers/ folder that imports from this file — same effect,
 * cleaner dependency direction. Included here for now since it's a
 * two-line function and splitting it doesn't buy much at this scale.
 */
export async function createTestAgentToolGrant(
  tenantId: string,
  createdBy: string,
  opts: { agent?: TestAgentOverrides; tool?: TestToolOverrides } = {}
) {
  const { agent } = await createTestAgent(tenantId, createdBy, opts.agent);
  const tool = await createTestTool(tenantId, opts.tool);
  const grant = await permissionRepository.create({
    tenantId,
    agentId: agent.id,
    toolId: tool.id,
  });
  return { agent, tool, grant };
}