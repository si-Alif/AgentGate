import { permissionService } from "../../../services/permission.service.js";
import {
  createTestTenant,
  createTestAgent,
  createSsrfBlockedTool,
} from "../../helpers/test-tenant.factory.js";
import type { FastifyInstance } from "fastify";

/**
 * Week 8 Day 3 — Decision 8.63 (Finding F1). Deliberately 5 tenants ×
 * 10 agents = 50 agents, NOT 50 tenants — see roadmap_w8_d3.md §A.3.
 * Agent/tool/permission creation goes through direct SERVICE-layer
 * calls (agentService/toolService/permissionService), exactly
 * mirroring test-tenant.factory.ts's own established convention —
 * these paths never touch Day 2's public-auth throttle at all, since
 * they never go through HTTP.
 *
 * Bootstrap runs strictly SEQUENTIALLY, tenant by tenant. This is
 * off the TIMED load-window path entirely (bootstrap happens inside
 * beforeAll, before any measurement begins) — sequential execution
 * here avoids any question of createTestTenant()'s own
 * resetRateLimitKeyForTest() calls racing each other across
 * concurrent invocations for no benefit, since total bootstrap cost
 * is a handful of seconds regardless.
 */

export const LOAD_TENANT_COUNT = 5;
export const AGENTS_PER_TENANT = 10;
export const TOTAL_AGENTS = LOAD_TENANT_COUNT * AGENTS_PER_TENANT; // 50

export interface LoadAgent {
  id: string;
  apiKey: string;
}

export interface LoadTenant {
  tenantId: string;
  userId: string;
  accessToken: string;
  toolId: string;
  toolName: string;
  agents: LoadAgent[];
}

export async function bootstrapLoadTenants(app: FastifyInstance): Promise<LoadTenant[]> {
  const tenants: LoadTenant[] = [];

  for (let t = 0; t < LOAD_TENANT_COUNT; t++) {
    const created = await createTestTenant(app);

    const toolRow = await createSsrfBlockedTool(created.tenantId, `load-tool-t${t}-${Date.now()}`);

    const agents: LoadAgent[] = [];
    for (let a = 0; a < AGENTS_PER_TENANT; a++) {
      const createdAgent = await createTestAgent(created.tenantId, created.userId);
      await permissionService.assignPermission(created.tenantId, {
        agentId: createdAgent.agent.id,
        toolId: toolRow.id,
      });
      agents.push({ id: createdAgent.agent.id, apiKey: createdAgent.apiKey });
    }

    tenants.push({
      tenantId: created.tenantId,
      userId: created.userId,
      accessToken: created.accessToken,
      toolId: toolRow.id,
      toolName: toolRow.name,
      agents,
    });
  }

  return tenants;
}

/**
 * Week 8 Day 3 — Decision 8.65 (Finding F3). A small, dependency-free,
 * bounded worker-pool executor — this project's own established
 * preference for building small utilities itself (withTimeout, Week
 * 4) rather than adding a library dependency (e.g. p-limit) for a
 * single, narrowly-scoped need.
 *
 * Concurrency is GLOBAL across the whole `items` array, not per any
 * subgrouping the caller might have in mind — this is what produces
 * genuine cross-agent interleaving when items span multiple agents'
 * own call batches, which is both the more realistic simulation of
 * concurrent production traffic AND the mechanism that keeps total
 * wall-clock time low (Finding F3's own mitigation).
 */
export async function runWithConcurrency<T, R>(
  items: readonly T[],
  worker: (item: T, index: number) => Promise<R>,
  concurrency: number
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function runOne(): Promise<void> {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!, index);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => runOne());
  await Promise.all(workers);
  return results;
}

/**
 * REST "management traffic" background poller (master plan's own
 * explicit requirement: load runs concurrently with ordinary REST
 * traffic, "not the MCP gateway in isolation"). Deliberately hits
 * ONLY unthrottled routes (GET /api/agents, GET /api/tools) — never
 * GET /api/audit-events, which carries its own 30/min-per-user
 * throttle (Week 5, fixed Week 7 Day 5) that this background traffic
 * has no reason to compete against, since today's own
 * gatewayOverheadMs measurement bypasses that HTTP route entirely
 * (Decision 8.67).
 */
export function startBackgroundRestPoller(
  app: FastifyInstance,
  tenants: readonly LoadTenant[],
  intervalMs: number
): { stop: () => void } {
  let stopped = false;

  const timers = tenants.map((tenant) => {
    return setInterval(() => {
      if (stopped) return;
      void app.inject({
        method: "GET",
        url: "/api/agents",
        headers: { Authorization: `Bearer ${tenant.accessToken}` },
      });
      void app.inject({
        method: "GET",
        url: "/api/tools",
        headers: { Authorization: `Bearer ${tenant.accessToken}` },
      });
    }, intervalMs);
  });

  return {
    stop: () => {
      stopped = true;
      timers.forEach(clearInterval);
    },
  };
}