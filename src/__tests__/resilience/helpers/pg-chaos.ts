import { prisma } from "../../../lib/prisma.js";



export async function killOneMainPoolBackend(): Promise<{ killed: boolean; pid: number | null }> {
  const rows = await prisma.$queryRaw<Array<{ pid: number }>>`
    SELECT pid FROM pg_stat_activity
    WHERE application_name = 'agentgate-main'
      AND pid <> pg_backend_pid()
      AND state = 'active'
    LIMIT 1
  `;
  const target = rows[0];
  if (!target) return { killed: false, pid: null };

  await prisma.$queryRaw`SELECT pg_terminate_backend(${target.pid})`;
  return { killed: true, pid: target.pid };
}

/**
 * The variant actually used by today's own chaos test — kills EVERY
 * currently-active OR idle main-pool backend except the one running
 * this query. Broader than killOneMainPoolBackend() on purpose: given
 * these lookups are typically sub-millisecond, a SINGLE kill attempt
 * would very likely miss any in-flight query entirely. Called
 * repeatedly, in a tight loop, by the test itself — see
 * whole-system-chaos.test.ts's own documented reasoning for why.
 */
export async function killAllMainPoolBackends(): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ pid: number }>>`
    SELECT pid FROM pg_stat_activity
    WHERE application_name = 'agentgate-main' AND pid <> pg_backend_pid()
  `;
  for (const row of rows) {
    await prisma.$queryRaw`SELECT pg_terminate_backend(${row.pid})`;
  }
  return rows.length;
}