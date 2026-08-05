import { prisma } from "../../../lib/prisma.js";
import { auditPrisma } from "../../../lib/audit-prisma.js";

/**
 * Week 8 Day 3 — Decision 8.66 (Finding F4). Polls pg_stat_activity,
 * discriminating by application_name (Step 2/3's patch) rather than
 * needing direct pg.Pool access — sidesteps the @prisma/adapter-pg
 * constructor-shape uncertainty flagged in §A.7 entirely.
 *
 * Uses the SAME singleton clients this observer is measuring to run
 * the polling query itself — a small, accepted, "precisely stated"
 * observer-effect (Week 3's own established pattern for this class
 * of imprecision): each poll consumes one connection FROM the pool
 * being measured, for the brief duration of the query. Deliberately
 * NOT a third, separate pool — a separate pool would itself distort
 * the very connection-count formula (Decision 8.14/8.37) today's run
 * is supposed to validate.
 */

export interface PoolSample {
  timestamp: number;
  active: number;
  idle: number;
  total: number;
}

export interface PoolSummary {
  applicationName: string;
  configuredMax: number;
  peakTotal: number;
  peakActive: number;
  sampleCount: number;
  sustainedAtMaxCount: number; // samples where total === configuredMax
}

async function sampleOne(applicationName: string): Promise<Omit<PoolSample, "timestamp">> {
  const rows = await prisma.$queryRaw<Array<{ active: bigint; idle: bigint; total: bigint }>>`
    SELECT
      count(*) FILTER (WHERE state = 'active') AS active,
      count(*) FILTER (WHERE state = 'idle') AS idle,
      count(*) AS total
    FROM pg_stat_activity
    WHERE application_name = ${applicationName}
  `;
  const row = rows[0]!;
  return { active: Number(row.active), idle: Number(row.idle), total: Number(row.total) };
}

export class DbPoolObserver {
  private samples: PoolSample[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly applicationName: string,
    private readonly configuredMax: number,
    private readonly intervalMs = 200
  ) { }

  start(): void {
    this.timer = setInterval(() => {
      void sampleOne(this.applicationName).then((s) => {
        this.samples.push({ timestamp: Date.now(), ...s });
      });
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  summary(): PoolSummary {
    const peakTotal = this.samples.reduce((max, s) => Math.max(max, s.total), 0);
    const peakActive = this.samples.reduce((max, s) => Math.max(max, s.active), 0);
    const sustainedAtMaxCount = this.samples.filter((s) => s.total >= this.configuredMax).length;
    return {
      applicationName: this.applicationName,
      configuredMax: this.configuredMax,
      peakTotal,
      peakActive,
      sampleCount: this.samples.length,
      sustainedAtMaxCount,
    };
  }
}

/**
 * Week 8 Day 3 — Decision 8.72. Turns an observed summary into a
 * concrete, reasoned recommendation, WITHOUT asserting a specific new
 * pool-size number that hasn't actually been measured (see
 * roadmap_w8_d3.md §A "What I'm Deliberately Not Changing"). If the
 * pool was NEVER observed pinned at its configured max, the existing
 * default is confirmed sufficient for this run's profile. If it WAS
 * sustained at max for a meaningful fraction of samples, this
 * recommends a specific new value with its own reasoning — the human
 * (or a future Day 7 pass) applies it.
 */
export function recommendPoolSize(summary: PoolSummary): { sufficient: boolean; recommendation: string } {
  const saturationRatio = summary.sampleCount > 0 ? summary.sustainedAtMaxCount / summary.sampleCount : 0;

  if (saturationRatio < 0.05) {
    return {
      sufficient: true,
      recommendation:
        `${summary.applicationName}: peak observed ${summary.peakTotal}/${summary.configuredMax} ` +
        `connections, pinned at max for only ${(saturationRatio * 100).toFixed(1)}% of samples — ` +
        `CONFIRMED sufficient for this run's profile, no change recommended.`,
    };
  }

  const recommendedMax = Math.ceil(summary.configuredMax * 1.5) + 5; // headroom, not a guess at exact demand
  return {
    sufficient: false,
    recommendation:
      `${summary.applicationName}: pinned at its configured max (${summary.configuredMax}) for ` +
      `${(saturationRatio * 100).toFixed(1)}% of samples — likely a real bottleneck under this load. ` +
      `Recommended new value: ${recommendedMax} (1.5x + 5 headroom over the observed ceiling). ` +
      `Re-run this suite after applying the change to confirm.`,
  };
}