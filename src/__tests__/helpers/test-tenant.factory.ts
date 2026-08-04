import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { agentService } from "../../services/agent.service.js";
import { toolService } from "../../services/tool.service.js";
import { encryptConfig } from "../../lib/encryption.js";

/**
 * Week 8 Day 1 — Decision 8.18 / Finding F2.
 *
 * THE single, authoritative shape for this factory, confirmed against
 * every Week 6/7 daily document's own usage (the freshest, most-used
 * convention in this project's history) — app.inject-based,
 * {tenantId, userId, accessToken}. Earlier weeks' documents (1-5)
 * sometimes show an older, Prisma-direct-insert style with no `app`
 * parameter, returning {id, ownerUserId}. Day 1 is the first day this
 * project imports and uses this factory across flows spanning that
 * entire range at once — the first day the drift becomes load-bearing
 * rather than cosmetic. If the real, on-disk file already matches this
 * shape, this patch is a no-op; confirm by direct read before treating
 * either possibility as certain, per this project's own "verify before
 * building on it" discipline.
 */

export interface TestTenantContext {
  tenantId: string;
  userId: string;
  accessToken: string;
}

export async function createTestTenant(app: FastifyInstance): Promise<TestTenantContext> {
  const suffix = crypto.randomUUID();
  const email = `owner-${suffix}@example.com`;
  const password = "TestPassword123!";

  await app.inject({
    method: "POST",
    url: "/auth/register-tenant",
    payload: {
      tenantName: `Tenant ${suffix}`,
      slug: `tenant-${suffix}`,
      ownerEmail: email,
      password,
    },
  });

  // Bypasses the (still-stub, Week 1) email queue entirely — reads the
  // verification token straight from Postgres, exactly as this
  // project's own factories have done since Week 1 Day 6. Nothing
  // about this factory, or anything built on top of it, is blocked by
  // Finding W8-1's still-open "email verification never left stub
  // state" gap (Decision 8.21 / Finding F5).
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  await app.inject({ method: "GET", url: `/auth/verify-email?token=${user.verificationToken}` });

  const loginRes = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { email, password },
  });
  const { accessToken } = JSON.parse(loginRes.body) as { accessToken: string };

  return { tenantId: user.tenantId, userId: user.id, accessToken };
}

export async function createTestAgent(tenantId: string, createdByUserId: string) {
  const result = await agentService.createAgent(tenantId, createdByUserId, {
    name: `agent-${crypto.randomUUID()}`,
  });
  return { agent: result.agent, apiKey: result.apiKey };
}

export interface CreateTestToolOverrides {
  name?: string;
  handlerType?: "http" | "postgres" | "web_fetch";
  handlerConfig?: unknown;
  inputSchema?: unknown;
}

export async function createTestTool(tenantId: string, overrides: CreateTestToolOverrides = {}) {
  return toolService.createTool(tenantId, {
    name: overrides.name ?? `tool-${crypto.randomUUID()}`,
    handlerType: overrides.handlerType ?? "web_fetch",
    handlerConfig: overrides.handlerConfig ?? { handlerType: "web_fetch", url: "https://example.com" },
    inputSchema: overrides.inputSchema ?? { type: "object", properties: {} },
  });
}

/**
 * Week 8 Day 1 — promoted here from six independent redefinitions
 * across Week 6 Days 4/6 and Week 7 Days 3/4/5/6's own test files (a
 * small, low-risk consolidation made while this file was already
 * being touched for Decision 8.18 — one primitive, defined once).
 *
 * A tool whose handler_config deliberately targets a literal loopback
 * address — rejected by SSRF Layer 1+2 (Week 2/Week 4) on every real
 * invocation, deterministically, without any real network dependency.
 * This is what lets a harness prove the FULL, real, unmocked
 * executeTool() pipeline runs (permission -> AJV -> rate limit ->
 * decrypt -> dispatch -> SSRF Layer 2 -> audit) without this
 * environment needing to stand up a real external HTTP target.
 *
 * Created via a DIRECT Prisma insert, bypassing toolService.createTool()
 * — Week 2's own Layer 1 pre-filter would reject a literal loopback
 * URL at creation time, exactly why every prior week's own tests
 * already work around it this same way.
 */
export async function createSsrfBlockedTool(tenantId: string, name?: string) {
  const ciphertext = encryptConfig(
    JSON.stringify({ handlerType: "http", url: "http://127.0.0.1:1/probe", method: "GET" }),
    tenantId
  );
  return prisma.tool.create({
    data: {
      tenantId,
      name: name ?? `ssrf-blocked-tool-${crypto.randomUUID()}`,
      handlerType: "http",
      handlerConfig: ciphertext,
      inputSchema: { type: "object", properties: {} },
      isActive: true,
    },
  });
}

export async function cleanupTenant(tenantId: string): Promise<void> {
  await prisma.tenant.delete({ where: { id: tenantId } }).catch(() => {
    // Best-effort — a tenant already removed by a prior cleanup call,
    // or never fully created due to an earlier assertion failure in
    // the SAME dependent-flow chain, is not itself a new failure.
  });
}