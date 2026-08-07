import { prisma } from "../../../lib/prisma.js";


export async function killOneMainPoolBackend(): Promise<{ killed: boolean; pid: number | null }> {
  const rows = await prisma.$queryRaw<Array<{ pid: number; pg_terminate_backend: boolean }>>`
    SELECT pid, pg_terminate_backend(pid)
      FROM pg_stat_activity
      WHERE application_name = 'agentgate-main'
        AND pid <> pg_backend_pid()
        AND state = 'active'
      LIMIT 1
  `;
  const target = rows[0];
  return target ? { killed: true, pid: target.pid } : { killed: false, pid: null };
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
  const rows = await prisma.$queryRaw<Array<{ pg_terminate_backend: boolean }>>`
    SELECT pg_terminate_backend(pid)
    FROM pg_stat_activity
    WHERE application_name = 'agentgate-main'
    AND pid <> pg_backend_pid()
  `;
  
  return rows.length;
}