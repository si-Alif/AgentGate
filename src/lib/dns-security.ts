import dns from "node:dns/promises";
import net from "node:net";
import { checkHostnameSafety, type NetworkSafetyCheckResult } from "./network-safety.js";
import { SsrfBlockedError, TimeoutError, DNS_TIMEOUT_MS } from "../handlers/types.js";

/**
 * DNS Security Primitive (Week 4, Day 1).
 *
 * One job: given a hostname, resolve it, validate EVERY candidate
 * address, and return exactly one validated target to connect to.
 * Knows nothing about HTTP, Undici, pg, or net.LookupFunction — that
 * adaptation lives in safe-lookup.ts.
 */

export interface ResolvedTarget {
  readonly hostname: string;
  readonly ip: string;
  readonly family: 4 | 6;
  readonly allResolvedIps: readonly string[];
}

// Pure — no signal (Decision #7). resolve4/resolve6 can't be
// meaningfully cancelled once fired regardless of where a signal
// lives, so putting one here would advertise a capability the
// resolver doesn't have. Cancellation is owned entirely by
// resolveAndValidate/assertSafeUrlHost below.
export type DnsResolver = (hostname: string) => Promise<readonly string[]>;

// Deliberately separate from DnsResolver (Decision #4): swapping only
// the resolver does not bypass validation. checkHostnameSafety runs
// unconditionally on whatever a resolver returns, and correctly,
// unavoidably classifies 127.0.0.1 as loopback regardless of who
// produced it — local Postgres/HTTP integration tests inject a
// permissive VALIDATOR here, never a different resolver alone.
//
// NOTE: assumes your real network-safety.ts exports
// `SafetyCheckResult { safe: boolean; reason?: string }`, matching
// this document's own §5 type contract. I don't have that file — if
// its actual field names differ (e.g. `isSafe`), reconcile one way
// or the other before this compiles against your real codebase.
export type IpValidator = (ip: string) => NetworkSafetyCheckResult;

export interface ResolveRequest {
  hostname: string;    // MUST already be extracted via new URL(input).hostname — see handler call sites (Decision #8)
  signal: AbortSignal;
  timeoutMs?: number;  // defaults to DNS_TIMEOUT_MS
}

function familyOf(ip: string): 4 | 6 {
  return net.isIPv6(ip) ? 6 : 4;
}

/**
 * resolve4()/resolve6() (c-ares), never dns.lookup() — the latter
 * shares libuv's threadpool with argon2's native binding, which runs
 * on every login and every SSE connect (HLD §6.1). A slow or simply
 * unresponsive hostname can stall platform-wide auth otherwise.
 * Verified: a ~15ms lookup ballooned to ~1673ms under a saturated
 * pool; resolve4() stayed ~15.7ms in the identical scenario.
 */
export const defaultDnsResolver: DnsResolver = async (hostname) => {
  const [v4, v6] = await Promise.allSettled([
    dns.resolve4(hostname),
    dns.resolve6(hostname),
  ]);

  const addresses = [
    ...(v4.status === "fulfilled" ? v4.value : []),
    ...(v6.status === "fulfilled" ? v6.value : []),
  ];

  if (addresses.length === 0) {
    // Preserve *why* both failed — don't discard the underlying
    // reason (§6.1 step 3).
    const v4Reason = v4.status === "rejected" ? (v4.reason?.message ?? String(v4.reason)) : "no A records";
    const v6Reason = v6.status === "rejected" ? (v6.reason?.message ?? String(v6.reason)) : "no AAAA records";
    throw new Error(`DNS returned no addresses for ${hostname} (A: ${v4Reason}; AAAA: ${v6Reason})`);
  }

  return [...new Set(addresses)];
};

/**
 * Races `promise` against `signal` firing, for whichever reason it
 * fires (the caller's own remaining budget, or this call's own
 * sub-deadline — see the AbortSignal.any() composition below,
 * whichever is smaller). Neither resolve4 nor resolve6 honor native
 * cancellation — Node's underlying query keeps running regardless —
 * so this bounds how long we WAIT, not the query itself. The
 * eventual late settlement is swallowed so it never surfaces as an
 * unhandled rejection.
 */
async function raceAgainstSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new TimeoutError("Aborted before DNS resolution");

  const { promise: abortPromise, reject } = Promise.withResolvers<T>();
  const onAbort = () => reject(new TimeoutError("DNS resolution aborted or timed out"));
  signal.addEventListener("abort", onAbort, { once: true });

  promise.catch(() => { });

  try {
    return await Promise.race([promise, abortPromise]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export async function resolveAndValidate(
  request: ResolveRequest,
  resolver: DnsResolver,
  validate: IpValidator = checkHostnameSafety
): Promise<ResolvedTarget> {
  const cleanHostname = request.hostname.replace(/^\[|\]$/g, "");

  if (request.signal.aborted) {
    throw new TimeoutError("Aborted before DNS resolution");
  }

  // Composes "however much of the overall tool-call budget remains"
  // with "this DNS call's own sub-deadline" — DNS can never consume
  // more than the smaller of the two (Node >=22 native API).
  const timeoutMs = request.timeoutMs ?? DNS_TIMEOUT_MS;
  const combinedSignal = AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]);

  const candidates = [...new Set(await raceAgainstSignal(resolver(cleanHostname), combinedSignal))];

  if (candidates.length === 0) {
    throw new Error(`DNS returned no addresses for ${cleanHostname}`);
  }

  for (const ip of candidates) {
    const result = validate(ip);
    if (!result.isSafe) {
      // Fail closed on the WHOLE resolution if ANY candidate is
      // unsafe (Decision #5) — a mixed response is a signal, not an
      // accident. Never filter down to just the safe ones.
      throw new SsrfBlockedError(cleanHostname, ip, result.reason ?? "blocked IP range", familyOf(ip), candidates);
    }
  }

  const ip = candidates[0]!; // safe: length checked above; noUncheckedIndexedAccess doesn't see through that
  return { hostname: cleanHostname, ip, family: familyOf(ip), allResolvedIps: candidates };
}

/**
 * VERIFIED CRITICAL FIX — closes the literal-IP SSRF bypass. Node's
 * connection layer skips any custom `lookup` function entirely when
 * the host is already a literal IP — nothing to "look up." Every
 * handler MUST call this before handing a URL to undici/pg.
 *
 * PRECONDITION (Decision #8): `request.hostname` must already come
 * from `new URL(input).hostname`. net.isIP() does not recognize
 * decimal/hex/octal IP obfuscation (2130706433, 0x7f000001,
 * 017700000001) — only the WHATWG URL parser normalizes those forms.
 * This function cannot verify that precondition internally; it is a
 * hard calling contract, not an implicit convention.
 */
export async function assertSafeUrlHost(
  request: ResolveRequest,
  resolver: DnsResolver,
  validate: IpValidator = checkHostnameSafety
): Promise<ResolvedTarget> {
  const cleanHostname = request.hostname.replace(/^\[|\]$/g, "");

  if (net.isIP(cleanHostname)) {
    const result = validate(cleanHostname);
    if (!result.isSafe) {
      throw new SsrfBlockedError(cleanHostname, cleanHostname, result.reason ?? "blocked IP range", familyOf(cleanHostname), [cleanHostname]);
    }
    return { hostname: cleanHostname, ip: cleanHostname, family: familyOf(cleanHostname), allResolvedIps: [cleanHostname] };
  }

  return resolveAndValidate({ ...request, hostname: cleanHostname }, resolver, validate);
}