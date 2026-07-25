import {UnsupportedMediaTypeError} from "../handlers/types.js";

const CHARSET_OR_PARAM_SUFFIX = /;.*$/;

export const SUPPORTED_WEBFETCH_MEDIA_TYPES: ReadonlySet<string> = new Set([
  "text/html",
  "application/xhtml+xml",
  "text/plain",
  "application/json",
]);

export function parseMediaType(contentTypeHeader: string | undefined): string | null {
  if (!contentTypeHeader) return null;
  const stripped = contentTypeHeader.replace(CHARSET_OR_PARAM_SUFFIX, "").trim().toLowerCase();
  return stripped.length > 0 ? stripped : null;
}

export function assertSupportedMediaType(mediaType: string | null): void {
  if (mediaType === null || !SUPPORTED_WEBFETCH_MEDIA_TYPES.has(mediaType)) {
    throw new UnsupportedMediaTypeError(mediaType);
  }
}

export function stripHtml(html: string): string {
  let text = html;
  text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<[^>]+>/g, "");
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
  return text.replace(/\s+/g, " ").trim();
}

export function extractReadableText(raw: string, mediaType: string): string {
  switch (mediaType) {
    case "text/html":
    case "application/xhtml+xml":
      return stripHtml(raw);
    case "text/plain":
    case "application/json":
      return raw.trim();
    default:
      throw new UnsupportedMediaTypeError(mediaType);
  }
}