import { TimeoutError } from "../handlers/types.js";

export async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  externalSignal?: AbortSignal
): Promise<T> {
  const combinedSignal = externalSignal
    ? AbortSignal.any([externalSignal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);

  if (combinedSignal.aborted) {
    throw new TimeoutError(describeAbort(combinedSignal, timeoutMs));
  }

  const { promise: abortPromise, reject } = Promise.withResolvers<never>();
  const onAbort = () => reject(new TimeoutError(describeAbort(combinedSignal, timeoutMs)));
  combinedSignal.addEventListener("abort", onAbort, { once: true });

  const inner = fn(combinedSignal);
  // If the race below settles via the abort branch, `inner` may
  // still be running underneath — cooperative cancellation is
  // best-effort, not instant. Swallow its eventual settlement so a
  // late resolution/rejection never surfaces as an unhandled
  // rejection. Identical pattern to dns-security.ts's
  // raceAgainstSignal.
  inner.catch(() => { });

  try {
    return await Promise.race([inner, abortPromise]);
  } finally {
    combinedSignal.removeEventListener("abort", onAbort);
  }
}

function describeAbort(signal: AbortSignal, timeoutMs: number): string {
  const reason = signal.reason;
  if (reason instanceof DOMException && reason.name === "TimeoutError") {
    return `Tool execution timed out after ${timeoutMs}ms`;
  }
  return "Tool execution aborted by external signal";
}