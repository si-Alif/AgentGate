import { auditPrisma } from "../../../lib/audit-prisma.js";

/**
 * Week 8 Day 3 — Decision 8.67 (Finding F5). Reads gatewayOverheadMs
 * DIRECTLY from the persisted audit_events.payload JSON field — the
 * only place this value is guaranteed present, given every response
 * this load produces is a JSON-RPC ERROR (SSRF-blocked), which
 * structurally omits _meta at the HTTP layer (Week 6 Day 4/5 design).
 * Populated unconditionally by executeTool()'s own audit() closure
 * (Week 6 Day 5 patch) regardless of final execution status.
 *
 * One batched query for the WHOLE population — never per-event HTTP
 * calls, which would themselves distort the load being measured.
 */
export async function sampleGatewayOverheadMs(tenantIds: readonly string[], since: Date): Promise<number[]> {
  const rows = await auditPrisma.$queryRaw<Array<{ overhead: number | null }>>`
    SELECT (payload->>'gatewayOverheadMs')::int AS overhead
    FROM audit_events
    WHERE tenant_id = ANY(${tenantIds})
      AND event_type = 'TOOL_INVOCATION'
      AND created_at >= ${since}
      AND payload ? 'gatewayOverheadMs'
  `;
  return rows.map((r) => r.overhead).filter((v): v is number => v !== null);
}

export function percentile(sortedValuesAscending: readonly number[], p: number): number {
  if (sortedValuesAscending.length === 0) return NaN;
  const index = Math.min(sortedValuesAscending.length - 1, Math.ceil((p / 100) * sortedValuesAscending.length) - 1);
  return sortedValuesAscending[Math.max(0, index)]!;
}

export function summarizeLatencies(samples: readonly number[]): {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
} {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted.length > 0 ? sorted[sorted.length - 1]! : NaN,
  };
}