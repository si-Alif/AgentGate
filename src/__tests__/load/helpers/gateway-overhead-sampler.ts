// helpers/gateway-overhead-sampler.ts

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
export async function sampleGatewayOverheadMs(
  tenantIds: readonly string[],
  since: Date
): Promise<number[]> {
  const rows = await auditPrisma.$queryRaw<
    Array<{ overhead: number | null }>
  >`
    SELECT (payload->>'gatewayOverheadMs')::int AS overhead
    FROM audit_events
    WHERE tenant_id = ANY(${tenantIds})
      AND event_type = 'TOOL_INVOCATION'
      AND created_at >= ${since}
      AND payload ? 'gatewayOverheadMs'
  `;
  return rows
    .map((r) => r.overhead)
    .filter((v): v is number => v !== null);
}

export function percentile(
  sortedValuesAscending: readonly number[],
  p: number
): number {
  if (sortedValuesAscending.length === 0) return NaN;
  const index = Math.min(
    sortedValuesAscending.length - 1,
    Math.ceil((p / 100) * sortedValuesAscending.length) - 1
  );
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

// ---------------------------------------------------------------------------
// Decision 9.12 – Phase‑level breakdown
// ---------------------------------------------------------------------------

export interface PhaseBreakdown {
  phase: string;
  p50: number;
  p95: number;
}

/**
 * Reads per‑phase timings from audit_events.payload where the gateway
 * instrumentation has recorded identityResolutionMs, toolLookupMs,
 * permissionCheckMs, ajvValidateMs, rateLimitCheckMs.
 *
 * The query extracts each phase’s value (integer, ms) and returns
 * an array of raw samples keyed by phase name.  We then compute the
 * p50 and p95 for each phase using the existing percentile helper.
 */
export async function sampleGatewayPhaseBreakdown(
  tenantIds: readonly string[],
  since: Date
): Promise<PhaseBreakdown[]> {
  const rows = await auditPrisma.$queryRaw<
    Array<{
      identityRes: number | null;
      toolLookup: number | null;
      permission: number | null;
      ajv: number | null;
      rateLimit: number | null;
      executeToolDbLookup: number | null; // NEW: Explicitly capture internal execution DB phase
    }>
  >`
    SELECT
      (payload->>'identityResolutionMs')::int AS "identityRes",
      (payload->>'toolLookupMs')::int          AS "toolLookup",
      (payload->>'permissionCheckMs')::int      AS "permission",
      (payload->>'ajvValidateMs')::int          AS "ajv",
      (payload->>'rateLimitCheckMs')::int       AS "rateLimit",
      (payload->>'executeToolDbLookupMs')::int  AS "executeToolDbLookup"
    FROM audit_events
    WHERE tenant_id = ANY(${tenantIds})
      AND event_type = 'TOOL_INVOCATION'
      AND created_at >= ${since}
      AND payload ? 'gatewayOverheadMs'
  `;

  const phases = new Map<string, number[]>([
    ["identityResolution", []],
    ["toolLookup", []],
    ["permissionCheck", []],
    ["ajvValidate", []],
    ["rateLimitCheck", []],
    ["executeToolDbLookup", []], // NEW
  ]);

  for (const row of rows) {
    if (row.identityRes !== null) phases.get("identityResolution")!.push(row.identityRes);
    if (row.toolLookup !== null) phases.get("toolLookup")!.push(row.toolLookup);
    if (row.permission !== null) phases.get("permissionCheck")!.push(row.permission);
    if (row.ajv !== null) phases.get("ajvValidate")!.push(row.ajv);
    if (row.rateLimit !== null) phases.get("rateLimitCheck")!.push(row.rateLimit);
    if (row.executeToolDbLookup !== null) phases.get("executeToolDbLookup")!.push(row.executeToolDbLookup);
  }

  const breakdown: PhaseBreakdown[] = [];
  for (const [phase, samples] of phases.entries()) {
    if (samples.length === 0) {
      breakdown.push({ phase, p50: NaN, p95: NaN });
      continue;
    }
    const sorted = [...samples].sort((a, b) => a - b);
    breakdown.push({
      phase,
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
    });
  }

  return breakdown;
}