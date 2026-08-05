import { describe, it, expect } from "vitest";
import { withApplicationName } from "../lib/pg-connection-string.js";

describe("withApplicationName — Week 8 Day 3, Decision 8.66", () => {
  it("appends application_name to a connection string with no existing query params", () => {
    const result = withApplicationName("postgresql://user:pass@host:5432/db", "agentgate-main");
    expect(result).toContain("application_name=agentgate-main");
  });

  it("preserves existing query params (e.g. sslmode) alongside the new one", () => {
    const result = withApplicationName("postgresql://user:pass@host:5432/db?sslmode=require", "agentgate-audit");
    expect(result).toContain("sslmode=require");
    expect(result).toContain("application_name=agentgate-audit");
  });

  it("overwrites a pre-existing application_name rather than duplicating the parameter", () => {
    const result = withApplicationName("postgresql://user:pass@host:5432/db?application_name=old", "new-name");
    expect(result.match(/application_name=/g)?.length).toBe(1);
    expect(result).toContain("application_name=new-name");
  });

  it("produces a value distinct for the main vs. audit pool tags", () => {
    const main = withApplicationName("postgresql://h/db", "agentgate-main");
    const audit = withApplicationName("postgresql://h/db", "agentgate-audit");
    expect(main).not.toBe(audit);
  });
});