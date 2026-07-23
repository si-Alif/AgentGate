import { describe, it, expect, vi, beforeEach } from "vitest";
import net from "node:net";
import crypto from "node:crypto";
import { promisify } from "node:util";
import {
  assertSafeUrlHost,
  resolveAndValidate,
  defaultDnsResolver,
} from "../lib/dns-security.js";
import { SsrfBlockedError, TimeoutError } from "../handlers/types.js";

// Utility to saturate the threadpool for our performance proof
const pbkdf2Async = promisify(crypto.pbkdf2);

// Mock Layer 1 Validator for isolated testing
// In reality, this would be your actual checkHostnameSafety function
const mockValidator = vi.fn((ip: string) => {
  if (ip === "127.0.0.1" || ip === "169.254.169.254" || ip === "::1" || ip.includes("169.254.169.254")) {
    return { isSafe: false, reason: "blocked range" };
  }
  return { isSafe: true };
});

describe("DNS Security Primitive (Layer 2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Literal IP Guard (assertSafeUrlHost)", () => {
    it("throws SsrfBlockedError on IPv4 loopback and NEVER calls resolver", async () => {
      const resolverSpy = vi.fn();
      const signal = AbortSignal.timeout(5000);

      await expect(
        assertSafeUrlHost({ hostname: "127.0.0.1", signal }, resolverSpy, mockValidator)
      ).rejects.toThrow(SsrfBlockedError);

      expect(resolverSpy).not.toHaveBeenCalled(); // The ultimate proof the bypass is closed
    });

    it("throws SsrfBlockedError on cloud metadata IP (169.254.169.254)", async () => {
      const resolverSpy = vi.fn();
      await expect(
        assertSafeUrlHost({ hostname: "169.254.169.254", signal: AbortSignal.timeout(5000) }, resolverSpy, mockValidator)
      ).rejects.toThrow(SsrfBlockedError);
      expect(resolverSpy).not.toHaveBeenCalled();
    });

    it("strips brackets and blocks IPv6 loopback ([::1])", async () => {
      const resolverSpy = vi.fn();
      await expect(
        assertSafeUrlHost({ hostname: "[::1]", signal: AbortSignal.timeout(5000) }, resolverSpy, mockValidator)
      ).rejects.toThrow(SsrfBlockedError);
    });

    it("blocks IPv4-mapped IPv6 literals (::ffff:169.254.169.254)", async () => {
      const resolverSpy = vi.fn();
      await expect(
        assertSafeUrlHost({ hostname: "::ffff:169.254.169.254", signal: AbortSignal.timeout(5000) }, resolverSpy, mockValidator)
      ).rejects.toThrow(SsrfBlockedError);
    });
  });

  describe("Mixed Candidate Lists & DNS Rebinding prep", () => {
    it("rejects the WHOLE resolution if any candidate is unsafe", async () => {
      // Mocking a malicious DNS server returning a safe IP and an internal IP
      const maliciousResolver = vi.fn().mockResolvedValue(["93.184.216.34", "127.0.0.1"]);
      const signal = AbortSignal.timeout(5000);

      await expect(
        resolveAndValidate({ hostname: "example.com", signal }, maliciousResolver, mockValidator)
      ).rejects.toThrow(SsrfBlockedError);
    });
  });

  describe("Timeout & Execution Budgets", () => {
    it("aborts a hanging DNS resolver gracefully within the timeout budget", async () => {
      // A resolver that never settles
      const hangingResolver = vi.fn().mockImplementation(() => new Promise(() => { }));

      // Give it a strict 50ms budget for the test
      const signal = AbortSignal.timeout(50);

      await expect(
        resolveAndValidate({ hostname: "example.com", signal }, hangingResolver, mockValidator)
      ).rejects.toThrow(TimeoutError);
    });
  });

  describe("Threadpool Non-Contention Proof (Critical Security Check)", () => {
    it("resolves external DNS without queueing behind saturated libuv workers", async () => {
      // 1. Establish a baseline resolution time
      const baselineStart = performance.now();
      await defaultDnsResolver("example.com");
      const baselineDuration = performance.now() - baselineStart;

      // 2. Saturate the libuv threadpool (default size is 4)
      // pbkdf2 uses the same threadpool as argon2/dns.lookup
      const heavyTasks = Array.from({ length: 4 }).map(() =>
        pbkdf2Async("password", "salt", 100000, 64, "sha512")
      );

      // 3. Fire our custom defaultDnsResolver concurrently
      const saturatedStart = performance.now();
      await defaultDnsResolver("example.com");
      const saturatedDuration = performance.now() - saturatedStart;

      // Ensure the heavy tasks finish so we don't leak them across tests
      await Promise.all(heavyTasks);

      // 4. Assert that the c-ares resolver wasn't blocked by the threadpool.
      // If we were using dns.lookup(), saturatedDuration would be hundreds of ms.
      // We allow a generous 50ms margin for normal network jitter.
      expect(saturatedDuration).toBeLessThan(baselineDuration + 50);
    });
  });

  describe("Testing Seam Verification", () => {
    it("allows local IPs if an explicitly permissive validator is injected", async () => {
      const permissiveValidator = vi.fn().mockReturnValue({ isSafe: true });
      const resolverSpy = vi.fn();
      const signal = AbortSignal.timeout(5000);

      const result = await assertSafeUrlHost(
        { hostname: "127.0.0.1", signal },
        resolverSpy,
        permissiveValidator
      );

      expect(result.ip).toBe("127.0.0.1");
      expect(permissiveValidator).toHaveBeenCalledWith("127.0.0.1");
    });
  });
});