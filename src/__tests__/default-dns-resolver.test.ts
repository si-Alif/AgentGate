import { describe, it, expect, vi } from "vitest";

vi.mock("node:dns/promises", () => {
  const mockResolve4 = vi.fn();
  const mockResolve6 = vi.fn();

  return {
    default: {
      resolve4: mockResolve4,
      resolve6: mockResolve6,
    },
    resolve4: mockResolve4,
    resolve6: mockResolve6,
  };
});

import dns from "node:dns/promises";
import { defaultDnsResolver } from "../lib/dns-security.js";

describe("defaultDnsResolver — dual-stack (A + AAAA) partial-failure tolerance", () => {
  it("tolerates a missing A record and still returns AAAA results", async () => {
    vi.mocked(dns.resolve4).mockRejectedValue(Object.assign(new Error("queryA ENOTFOUND"), { code: "ENOTFOUND" }));
    vi.mocked(dns.resolve6).mockResolvedValue(["2001:db8::1"]);
    expect(await defaultDnsResolver("aaaa-only.example")).toEqual(["2001:db8::1"]);
  });

  it("tolerates a missing AAAA record and still returns A results", async () => {
    vi.mocked(dns.resolve4).mockResolvedValue(["93.184.216.34"]);
    vi.mocked(dns.resolve6).mockRejectedValue(Object.assign(new Error("queryAaaa ENOTFOUND"), { code: "ENOTFOUND" }));
    expect(await defaultDnsResolver("a-only.example")).toEqual(["93.184.216.34"]);
  });

  it("combines both families when both resolve", async () => {
    vi.mocked(dns.resolve4).mockResolvedValue(["93.184.216.34"]);
    vi.mocked(dns.resolve6).mockResolvedValue(["2001:db8::1"]);
    const addresses = await defaultDnsResolver("dual.example");
    expect(new Set(addresses)).toEqual(new Set(["93.184.216.34", "2001:db8::1"]));
  });

  it("throws ONE error citing BOTH failure reasons when neither family resolves", async () => {
    vi.mocked(dns.resolve4).mockRejectedValue(new Error("queryA ENOTFOUND"));
    vi.mocked(dns.resolve6).mockRejectedValue(new Error("queryAaaa ENOTFOUND"));
    await expect(defaultDnsResolver("nowhere.example")).rejects.toThrow(/A:.*AAAA:/s);
  });

  it("de-duplicates identical addresses returned by both families", async () => {
    vi.mocked(dns.resolve4).mockResolvedValue(["93.184.216.34", "93.184.216.34"]);
    vi.mocked(dns.resolve6).mockResolvedValue([]);
    expect(await defaultDnsResolver("dup.example")).toEqual(["93.184.216.34"]);
  });
});
