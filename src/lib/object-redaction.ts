import { redactSecrets } from "./error-redaction.js";

export const AUDIT_REDACTION_MAX_DEPTH = 6;
export const AUDIT_REDACTION_MAX_KEYS = 500;


const SENSITIVE_KEY_PATTERN =
  /password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|encryption[_-]?key|connection[_-]?string|authorization|bearer|credential|session[_-]?id|\bssn\b|social[_-]?security/i;

interface WalkCounter {
  count: number;
}

export function redactSensitiveFields(value: unknown): unknown {
  return walk(value, 0, { count: 0 });
}

function walk(value: unknown, depth: number, counter: WalkCounter): unknown {
  if (value === null || value === undefined) return value;

  const t = typeof value;

  if (t === "boolean" || t === "number") return value;

  // JSON.stringify throws on BigInt — convert defensively at the leaf,
  // before it ever reaches the downstream serializer.
  if (t === "bigint") return (value as bigint).toString();

  if (t === "string") {
    // Leaf string — no JSON-quoting problem here, so Week 4's
    // pattern-based scrubber works correctly at exactly this boundary.
    return redactSecrets(value as string);
  }

  // Dates are `typeof === "object"` but Object.entries(date) === [] —
  // without this special case they'd silently collapse to `{}`.
  if (value instanceof Date) return value.toISOString();

  if (depth >= AUDIT_REDACTION_MAX_DEPTH) {
    return "[REDACTION_DEPTH_EXCEEDED]";
  }

  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      if (counter.count >= AUDIT_REDACTION_MAX_KEYS) {
        out.push("[REDACTION_LIMIT_EXCEEDED]");
        break;
      }
      counter.count++; // counts EVERY element visited, not once per array
      out.push(walk(item, depth + 1, counter));
    }
    return out;
  }

  if (t === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (counter.count >= AUDIT_REDACTION_MAX_KEYS) {
        out["_truncated"] = "[REDACTION_LIMIT_EXCEEDED]";
        break;
      }
      counter.count++; // counts EVERY key visited — this is the fix for
      // the bug in the other implementation, which incremented once per
      // *object*, making its "500 key" bound a no-op against a single
      // wide object.
      out[key] = SENSITIVE_KEY_PATTERN.test(key) ? "[REDACTED]" : walk(child, depth + 1, counter);
    }
    return out;
  }

  // functions, symbols, Map/Set (whose data isn't in own-enumerable
  // properties, so Object.entries would silently lose it) — never throw,
  // always return something serializable.
  return "[UNSUPPORTED_VALUE_TYPE]";
}