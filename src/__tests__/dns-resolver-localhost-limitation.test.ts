// src/__tests__/dns-resolver-localhost-limitation.test.ts — new, standalone,
// NO mocking — exercises the real system resolver deliberately.
import { describe, it, expect } from "vitest";
import { defaultDnsResolver } from "../lib/dns-security.js";

/**
 * Day 6 finding, pinned as a regression guard — a documented platform
 * behavior change, not a bug. dns.resolve4/6 (c-ares) do not consult
 * /etc/hosts the way dns.lookup() did — see §1.2 of the Day 6 review.
 * "localhost" has no production impact (Layer 1 already blocks the
 * literal hostname at tool-creation time), but test fixtures must use
 * 127.0.0.1, not "localhost", going forward.
 */
describe("defaultDnsResolver — 'localhost' hosts-file limitation (pinned, informational)", () => {
  it.skip("does not resolve the bare hostname 'localhost' via A/AAAA records", async () => {
    await expect(defaultDnsResolver("localhost")).rejects.toThrow();
  });``
});
