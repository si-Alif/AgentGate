// load-harness.ts

import { permissionService } from "../../../services/permission.service.js";
import {
  createTestTenant,
  createTestAgent,
  createSsrfBlockedTool,
} from "../../helpers/test-tenant.factory.js";
import type { FastifyInstance } from "fastify";

export const LOAD_TENANT_COUNT = 5;
export const AGENTS_PER_TENANT = 10;
export const TOTAL_AGENTS = LOAD_TENANT_COUNT * AGENTS_PER_TENANT;

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

export async function bootstrapLoadTenants(
  app: FastifyInstance,
  targetUrl?: string
): Promise<LoadTenant[]> {
  const tenants: LoadTenant[] = [];

  for (let t = 0; t < LOAD_TENANT_COUNT; t++) {
    const created = await createTestTenant(app);
    const toolRow = await createSsrfBlockedTool(
      created.tenantId,
      `load-tool-t${t}-${Date.now()}`,
      targetUrl
    );

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

export function startBackgroundRestPoller(
  app: FastifyInstance,
  tenants: readonly LoadTenant[],
  intervalMs: number
): { stop: () => void } {
  let stopped = false;

  const timers = tenants.map((tenant) => {
    return setInterval(() => {
      if (stopped) return;
      // Catch rejections so they never become unhandled
      app.inject({
        method: "GET",
        url: "/api/agents",
        headers: { Authorization: `Bearer ${tenant.accessToken}` },
      }).catch(() => { });
      app.inject({
        method: "GET",
        url: "/api/tools",
        headers: { Authorization: `Bearer ${tenant.accessToken}` },
      }).catch(() => { });
    }, intervalMs);
  });

  return {
    stop: () => {
      stopped = true;
      timers.forEach(clearInterval);
    },
  };
}