import { describe, it, expect, vi } from "vitest";
import crypto from "node:crypto";
import { promisify } from "node:util";
import {
  assertSafeUrlHost,
  resolveAndValidate,
  defaultDnsResolver,
} from "../lib/dns-security.js";
import { checkHostnameSafety } from "../lib/network-safety.js";
import { SsrfBlockedError } from "../handlers/types.js";

const pbkdf2Async = promisify(crypto.pbkdf2);
const permissive = () => ({ isSafe: true });

describe("assertSafeUrlHost — literal-IP fast path (Day 6, the critical regression suite)", () => {
  it("blocks a literal loopback IP WITHOUT ever invoking the resolver", async () => {
    const resolverSpy = vi.fn();
    await expect(
      assertSafeUrlHost({ hostname: "127.0.0.1", signal: new AbortController().signal }, resolverSpy)
    ).rejects.toThrow(SsrfBlockedError);
    // This is the load-bearing assertion. If the resolver were ever
    // called here, it would mean the literal-IP fast path was
    // bypassed and the code fell through to DNS resolution instead —
    // exactly the state that let the literal-IP bypass exist in the
    // first place.
    expect(resolverSpy).not.toHaveBeenCalled();
  });

  it("allows a literal public IP without invoking the resolver", async () => {
    const resolverSpy = vi.fn();
    const result = await assertSafeUrlHost(
      { hostname: "93.184.216.34", signal: new AbortController().signal },
      resolverSpy
    );
    expect(result.ip).toBe("93.184.216.34");
    expect(resolverSpy).not.toHaveBeenCalled();
  });

  it("blocks the literal cloud-metadata IP — no hostname needed to reach it", async () => {
    await expect(
      assertSafeUrlHost({ hostname: "169.254.169.254", signal: new AbortController().signal }, vi.fn())
    ).rejects.toThrow(SsrfBlockedError);
  });

  it("blocks a bracketed literal IPv6 loopback via the literal-IP path, not DNS", async () => {
    const resolverSpy = vi.fn();
    await expect(
      assertSafeUrlHost({ hostname: "[::1]", signal: new AbortController().signal }, resolverSpy)
    ).rejects.toThrow(SsrfBlockedError);
    expect(resolverSpy).not.toHaveBeenCalled();
  });

  it("blocks a literal IPv4-mapped IPv6 loopback (::ffff:127.0.0.1)", async () => {
    await expect(
      assertSafeUrlHost({ hostname: "::ffff:127.0.0.1", signal: new AbortController().signal }, vi.fn())
    ).rejects.toThrow(SsrfBlockedError);
  });

  it("a genuine hostname (not a literal IP) DOES fall through to the resolver", async () => {
    const resolverSpy = vi.fn().mockResolvedValue(["93.184.216.34"]);
    const result = await assertSafeUrlHost(
      { hostname: "public.example.com", signal: new AbortController().signal },
      resolverSpy
    );
    expect(resolverSpy).toHaveBeenCalledWith("public.example.com");
    expect(result.ip).toBe("93.184.216.34");
  });
});

describe("resolveAndValidate — rebinding & mixed-candidate matrix (retained + expanded)", () => {
  it("blocks if ANY candidate is unsafe, regardless of ordering", async () => {
    await expect(
      resolveAndValidate(
        { hostname: "mixed-a.example", signal: new AbortController().signal },
        async () => ["93.184.216.34", "169.254.169.254"]
      )
    ).rejects.toThrow(SsrfBlockedError);

    await expect(
      resolveAndValidate(
        { hostname: "mixed-b.example", signal: new AbortController().signal },
        async () => ["169.254.169.254", "93.184.216.34"]
      )
    ).rejects.toThrow(SsrfBlockedError);
  });

  it("simulates DNS rebinding: same hostname, safe on the first call, unsafe on the next", async () => {
    let call = 0;
    const rebinder = async () => (++call === 1 ? ["93.184.216.34"] : ["10.0.0.5"]);
    const req = () => ({ hostname: "attacker.example", signal: new AbortController().signal });

    const first = await resolveAndValidate(req(), rebinder);
    expect(first.ip).toBe("93.184.216.34");
    await expect(resolveAndValidate(req(), rebinder)).rejects.toThrow(SsrfBlockedError);
  });

  it("dedupes duplicate candidate addresses before validating", async () => {
    const resolver = async () => ["93.184.216.34", "93.184.216.34"];
    const result = await resolveAndValidate({ hostname: "dup.example", signal: new AbortController().signal }, resolver);
    expect(result.allResolvedIps).toEqual(["93.184.216.34"]);
  });

  it("bounds waiting time near the sub-timeout for a hanging resolver, not the full handler budget", async () => {
    const hangs = () => new Promise<string[]>(() => { });
    const start = Date.now();
    await expect(
      resolveAndValidate({ hostname: "hangs.example", signal: new AbortController().signal, timeoutMs: 300 }, hangs)
    ).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(1_500);
  });

  it("honors the caller's own AbortSignal firing before the DNS sub-timeout would", async () => {
    const controller = new AbortController();
    const slow = () => new Promise<string[]>((resolve) => setTimeout(() => resolve(["93.184.216.34"]), 5_000));
    setTimeout(() => controller.abort(), 50);
    const start = Date.now();
    await expect(
      resolveAndValidate({ hostname: "caller-abort.example", signal: controller.signal, timeoutMs: 5_000 }, slow)
    ).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(1_000);
  });

  it("the validator seam (not the resolver seam) is the only way to legitimately reach a loopback target in tests", async () => {
    const loopbackResolver = async () => ["127.0.0.1"];
    const result = await resolveAndValidate(
      { hostname: "test-only-host", signal: new AbortController().signal },
      loopbackResolver,
      permissive
    );
    expect(result.ip).toBe("127.0.0.1");
  });
});

describe("Threadpool Non-Contention Proof (Critical Security Check)", () => {
  it("resolves external DNS without queueing behind saturated libuv workers", async () => {
    const baselineStart = performance.now();
    await defaultDnsResolver("example.com");
    const baselineDuration = performance.now() - baselineStart;

    const heavyTasks = Array.from({ length: 4 }).map(() =>
      pbkdf2Async("password", "salt", 100000, 64, "sha512")
    );

    const saturatedStart = performance.now();
    await defaultDnsResolver("example.com");
    const saturatedDuration = performance.now() - saturatedStart;

    await Promise.all(heavyTasks);

    expect(saturatedDuration).toBeLessThan(baselineDuration + 50);
  });
});

describe("network-safety.ts field-naming contract (Day 6 — Finding #8 regression guard)", () => {
  it("checkHostnameSafety exposes isSafe, not safe — catches a silent field-name drift across the Week 2 → Week 4 boundary", () => {
    const result = (checkHostnameSafety("127.0.0.1") as unknown) as Record<string, unknown>;
    expect(result).toHaveProperty("isSafe");
    expect(result.safe).toBeUndefined();
  });
});