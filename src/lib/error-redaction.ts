const URL_CREDENTIAL_PATTERN = /(:\/\/[^:/@\s]+):([^@\s]*)@/g;
const BEARER_TOKEN_PATTERN = /\b(Bearer)\s+[A-Za-z0-9\-._~+/]+=*/gi;
const KEY_VALUE_SECRET_PATTERN =
  /\b((?:api[_-]?key|apikey|secret|token|password|passwd|pwd)\s*[:=]\s*)([^\s&"']+)/gi;

/**
 * A Cycle-Safe Recursive Redactor.
 * Traverses objects/arrays to redact sensitive keys, and applies regex redaction to strings.
 */
export function redactSecrets<T>(value: T): T {
  return redactRecursive(value, new WeakSet(), 0) as T;
}

function redactRecursive(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  // Depth limit protects against massive payloads blowing the call stack
  if (depth > 10) return "[MAX_DEPTH_REACHED]";
  if (value === null || value === undefined) return value;

  // If it's a string, apply our Week 4 regex scrubbing
  if (typeof value === "string") {
    return value
      .replace(URL_CREDENTIAL_PATTERN, "$1:***@")
      .replace(BEARER_TOKEN_PATTERN, "$1 ***")
      .replace(KEY_VALUE_SECRET_PATTERN, "$1***");
  }

  // If it's a primitive (number, boolean), return as-is
  if (typeof value !== "object") {
    return value;
  }

  // Cycle-Safe Redaction: Prevent circular reference crashes (TypeError)
  if (seen.has(value as object)) {
    return "[CIRCULAR]";
  }
  seen.add(value as object);

  // Recursively process arrays
  if (Array.isArray(value)) {
    return value.map((item) => redactRecursive(item, seen, depth + 1));
  }

  // Recursively process objects, scrubbing known sensitive keys outright
  const redactedObj: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const lowerKey = k.toLowerCase();
    if (
      lowerKey.includes("secret") ||
      lowerKey.includes("password") ||
      lowerKey.includes("token") ||
      lowerKey === "apikey" ||
      lowerKey === "api_key"
    ) {
      redactedObj[k] = "[REDACTED]";
    } else {
      redactedObj[k] = redactRecursive(v, seen, depth + 1);
    }
  }

  return redactedObj;
}