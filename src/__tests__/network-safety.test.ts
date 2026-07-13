import { describe, it, expect } from "vitest";
import { checkHttpUrlSafety, checkPostgresConnectionStringSafety } from "../lib/network-safety.js";

describe("checkHttpUrlSafety", () => {
  it("allows a public https URL", () => {
    expect(checkHttpUrlSafety("https://api.example.com/webhook").isSafe).toBe(true);
  });

  it("rejects disallowed schemes", () => {
    expect(checkHttpUrlSafety("file:///etc/passwd").isSafe).toBe(false);
    expect(checkHttpUrlSafety("ftp://internal-host/").isSafe).toBe(false);
  });

  it("rejects loopback across obfuscation encodings", () => {
    const variants = [
      "http://127.0.0.1/",
      "http://127.1/",
      "http://2130706433/",       // decimal
      "http://0x7f000001/",       // hex
      "http://017700000001/",     // octal
      "http://[::1]/",
      "http://[::ffff:127.0.0.1]/",
    ];
    for (const url of variants) {
      expect(checkHttpUrlSafety(url).isSafe, `expected ${url} to be rejected`).toBe(false);
    }
  });

  it("rejects the cloud metadata IP", () => {
    expect(checkHttpUrlSafety("http://169.254.169.254/latest/meta-data/").isSafe).toBe(false);
  });

  it("rejects RFC1918 private ranges", () => {
    expect(checkHttpUrlSafety("http://10.0.0.5/").isSafe).toBe(false);
    expect(checkHttpUrlSafety("http://192.168.1.1/").isSafe).toBe(false);
    expect(checkHttpUrlSafety("http://172.16.0.1/").isSafe).toBe(false);
  });

  it("rejects the literal 'localhost' hostname", () => {
    expect(checkHttpUrlSafety("http://localhost/").isSafe).toBe(false);
  });

  it("passes real hostnames through Layer 1 (Layer 2 handles DNS-time risk)", () => {
    expect(checkHttpUrlSafety("https://internal-sounding-name.example.com/").isSafe).toBe(true);
  });
});

describe("checkPostgresConnectionStringSafety", () => {
  it("allows a well-formed external connection string", () => {
    expect(checkPostgresConnectionStringSafety("postgresql://user:pass@db.example.com:5432/mydb").isSafe).toBe(true);
  });

  it("rejects a connection string pointed at loopback", () => {
    expect(checkPostgresConnectionStringSafety("postgresql://user:pass@127.0.0.1:5432/mydb").isSafe).toBe(false);
  });

  it("rejects non-postgres schemes", () => {
    expect(checkPostgresConnectionStringSafety("mysql://user:pass@db.example.com/mydb").isSafe).toBe(false);
  });

  it("rejects multi-host connection strings", () => {
    expect(checkPostgresConnectionStringSafety("postgresql://user@host1:5432,host2:5432/db").isSafe).toBe(false);
  });
});