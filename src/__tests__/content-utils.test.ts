import { describe, it, expect } from "vitest";
import {
  parseMediaType,
  assertSupportedMediaType,
  extractReadableText,
  stripHtml,
  SUPPORTED_WEBFETCH_MEDIA_TYPES,
} from "../lib/content-utils.js";
import { UnsupportedMediaTypeError } from "../handlers/types.js";

describe("parseMediaType", () => {
  it("strips a charset parameter and lowercases", () => {
    expect(parseMediaType("text/HTML; charset=utf-8")).toBe("text/html");
  });
  it("returns the bare type when there is no parameter", () => {
    expect(parseMediaType("application/json")).toBe("application/json");
  });
  it("returns null for an absent header", () => {
    expect(parseMediaType(undefined)).toBeNull();
  });
  it("returns null for an empty/whitespace-only header", () => {
    expect(parseMediaType("   ")).toBeNull();
  });
});

describe("assertSupportedMediaType", () => {
  it("accepts every member of the allowlist", () => {
    for (const type of SUPPORTED_WEBFETCH_MEDIA_TYPES) {
      expect(() => assertSupportedMediaType(type)).not.toThrow();
    }
  });
  it("rejects a binary type", () => {
    expect(() => assertSupportedMediaType("image/png")).toThrow(UnsupportedMediaTypeError);
  });
  it("rejects null (missing header) — fail-closed default", () => {
    expect(() => assertSupportedMediaType(null)).toThrow(UnsupportedMediaTypeError);
  });
});

describe("stripHtml", () => {
  it("removes script/style blocks including their content", () => {
    const html = "<html><head><style>body{color:red}</style></head><body><script>evil()</script><h1>Hello</h1></body></html>";
    expect(stripHtml(html)).toBe("Hello");
  });
  it("decodes the fixed entity set", () => {
    expect(stripHtml("<p>Tom &amp; Jerry &quot;fun&quot;</p>")).toBe('Tom & Jerry "fun"');
  });
  it("collapses whitespace", () => {
    expect(stripHtml("<p>Hello   \n\n  World</p>")).toBe("Hello World");
  });
});

describe("extractReadableText", () => {
  it("strips HTML for text/html", () => {
    expect(extractReadableText("<p>Hi</p>", "text/html")).toBe("Hi");
  });
  it("passes text/plain through unchanged (trimmed)", () => {
    expect(extractReadableText("  raw text  ", "text/plain")).toBe("raw text");
  });
  it("passes application/json through as raw text, not parsed", () => {
    const raw = '{"a":1}';
    expect(extractReadableText(raw, "application/json")).toBe(raw);
  });
});