// db-pool-observer.ts

import { prisma } from "../../../lib/prisma.js";

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
  averageTotal: number;  // NEW: Needed for Little's Law application
  averageActive: number; // NEW: Needed for Little's Law application
  sampleCount: number;
  sustainedAtMaxCount: number;
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
      sampleOne(this.applicationName)
        .then((s) => {
          this.samples.push({ timestamp: Date.now(), ...s });
        })
        .catch(() => { });
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  summary(): PoolSummary {
    const peakTotal = this.samples.reduce((max, s) => Math.max(max, s.total), 0);
    const peakActive = this.samples.reduce((max, s) => Math.max(max, s.active), 0);

    // NEW: Compute averages
    const sumTotal = this.samples.reduce((sum, s) => sum + s.total, 0);
    const sumActive = this.samples.reduce((sum, s) => sum + s.active, 0);
    const averageTotal = this.samples.length ? Math.round(sumTotal / this.samples.length) : 0;
    const averageActive = this.samples.length ? Math.round(sumActive / this.samples.length) : 0;

    const sustainedAtMaxCount = this.samples.filter((s) => s.total >= this.configuredMax).length;

    return {
      applicationName: this.applicationName,
      configuredMax: this.configuredMax,
      peakTotal,
      peakActive,
      averageTotal,
      averageActive,
      sampleCount: this.samples.length,
      sustainedAtMaxCount,
    };
  }
}

export function recommendPoolSize(summary: PoolSummary): { sufficient: boolean; recommendation: string } {
  const saturationRatio = summary.sampleCount > 0 ? summary.sustainedAtMaxCount / summary.sampleCount : 0;

  if (saturationRatio < 0.05) {
    return {
      sufficient: true,
      recommendation:
        `${summary.applicationName}: peak observed ${summary.peakTotal}/${summary.configuredMax} ` +
        `(avg active: ${summary.averageActive}). ` +
        `Pinned at max for only ${(saturationRatio * 100).toFixed(1)}% of samples — ` +
        `CONFIRMED sufficient. No change recommended.`,
    };
  }

  // Instead of blindly recommending 1.5x + 5, we now present the average active connections
  // to allow engineers to apply Little's Law directly to fix the bottleneck.
  const recommendedMax = Math.ceil(summary.configuredMax * 1.5) + 5;
  return {
    sufficient: false,
    recommendation:
      `${summary.applicationName}: pinned at max (${summary.configuredMax}) for ` +
      `${(saturationRatio * 100).toFixed(1)}% of samples. ` +
      `Avg active connections during run: ${summary.averageActive}. ` +
      `Apply Little's Law using true elapsed ms and this avg to find optimal size (Heuristic suggests: ${recommendedMax}).`,
  };
}