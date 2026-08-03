import { describe, it, expect } from "vitest";
import { redactTicketFromUrl } from "../lib/request-log-redaction.js";

describe("redactTicketFromUrl — Week 7 Day 6, Finding F3", () => {
  it("redacts a ticket value from a query string", () => {
    const url = "/observability/stream?ticket=abcDEF123_-xyz";
    expect(redactTicketFromUrl(url)).toBe("/observability/stream?ticket=[REDACTED]");
  });

  it("redacts a ticket that is NOT the first query parameter, preserving siblings", () => {
    const redacted = redactTicketFromUrl("/observability/stream?foo=bar&ticket=SECRETVALUE&baz=qux");
    expect(redacted).not.toContain("SECRETVALUE");
    expect(redacted).toContain("foo=bar");
    expect(redacted).toContain("baz=qux");
  });

  it("leaves a URL with no ticket parameter completely unchanged", () => {
    const url = "/api/agents?limit=10";
    expect(redactTicketFromUrl(url)).toBe(url);
  });

  it("is idempotent — redacting an already-redacted URL changes nothing further", () => {
    const once = redactTicketFromUrl("/observability/stream?ticket=SECRET");
    expect(redactTicketFromUrl(once)).toBe(once);
  });

  it("handles a URL with no query string at all", () => {
    expect(redactTicketFromUrl("/health")).toBe("/health");
  });

  it("defensively redacts multiple ticket-like params without throwing or leaking either value", () => {
    const redacted = redactTicketFromUrl("/x?ticket=first&ticket=second");
    expect(redacted).not.toContain("first");
    expect(redacted).not.toContain("second");
  });
});