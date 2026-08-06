import { auditQueue } from "../../../queue/audit.queue.js";
import type { SystemHarness } from "../../helpers/system-harness.js";

const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 250;

/**
 *
 * Polls the SAME queue-depth computation getAuditHealth() already uses
 * (Week 5 Day 4: waiting + active + delayed) until it reaches zero, or
 * a bounded timeout elapses. THEN closes the audit worker.
 *
 * This ordering — drain, THEN close, THEN (only in the caller) delete
 * tenants — is what closes the actual root cause: even if the drain
 * wait times out with a residual backlog, closing the worker first
 * means nothing further will attempt to write against a tenant that's
 * about to be deleted. A leftover backlog after a timeout is a
 * harmless, logged, self-explaining anomaly — never an active race.
 *
 * Never throws. A cleanup helper that itself fails would be its own
 * incident, mirroring this project's own established discipline for
 * every other guarded teardown step (Week 5's bounded worker.close(),
 * Week 7's closeConnectionForShutdown()).
 */
export async function drainAuditQueueAndCloseWorker(
  harness: Pick<SystemHarness, "auditWorker">,
  timeoutMs: number = DEFAULT_DRAIN_TIMEOUT_MS
): Promise<{ drained: boolean; residualDepth: number }> {
  const start = Date.now();
  let depth = await queueDepth();

  while (depth > 0 && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    depth = await queueDepth();
  }

  const drained = depth === 0;
  if (!drained) {
    console.warn(
      `[audit-drain] queue did not fully drain within ${timeoutMs}ms — ${depth} job(s) remain. ` +
      `Closing the worker now regardless, BEFORE any tenant deletion, so the residual backlog ` +
      `goes inert rather than racing the delete. These jobs will simply never be processed — ` +
      `acceptable for a load-test run being torn down, not acceptable in production.`
    );
  }

  try {
    await harness.auditWorker.close();
  } catch (err) {
    console.warn("[audit-drain] auditWorker.close() failed during drain teardown:", err);
  }

  return { drained, residualDepth: depth };
}

async function queueDepth(): Promise<number> {
  const [waiting, active, delayed] = await Promise.all([
    auditQueue.getWaitingCount(),
    auditQueue.getActiveCount(),
    auditQueue.getDelayedCount(),
  ]);
  return waiting + active + delayed;
}

/**
 * Companion to the drain wait (Decision 8.76) — reused by the
 * gatewayOverheadMs sampling test, which otherwise races the SAME
 * undrained backlog from the opposite direction (querying too EARLY
 * rather than deleting too EARLY).
 */
export async function waitForCondition(
  assertion: () => Promise<void> | void,
  timeoutMs = 20_000,
  intervalMs = 300
): Promise<void> {
  const start = Date.now();
  while (true) {
    try {
      await assertion();
      return;
    } catch (err) {
      if (Date.now() - start > timeoutMs) throw err;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}