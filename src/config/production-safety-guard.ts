import crypto from "node:crypto";
import { env } from "./env.js";

/**
 * Week 9 Day 2 — Decision 9.17 (originally Decision 8.10, Week 8).
 * The SECOND, independent layer of config validation. env.ts's own
 * zod schema already proves every required variable is PRESENT and
 * correctly SHAPED (including "SendGrid key required when
 * provider=sendgrid" — email-integration-roadmap.md's own
 * superRefine). This guard proves something zod structurally cannot:
 * that a present, correctly-shaped value isn't a known-insecure
 * DEFAULT. Same "shape validation is not safety validation" split
 * this project already drew once for tenant-submitted URLs (SSRF
 * Layer 1 vs Layer 2) — applied here to boot-time config instead.
 *
 * Runs ONCE, synchronously, before app.listen() — and ONLY when
 * AGENTGATE_NODE_ENV === "production". A placeholder secret in local
 * .env is normal; the same value in production is not.
 */

type SecretKind = "random-secret" | "hex-key" | "connection-string";

interface SecretPolicy {
  name: string;
  kind: SecretKind;
  minLength?: number;
  value: () => string | undefined;
  appliesWhen?: () => boolean;
}

const KNOWN_PLACEHOLDER_VALUES = new Set(
  [
    "change-this-to-a-random-string-at-least-32-chars-long",
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "changeme",
    "change-me",
    "password",
    "secret",
    "your-secret-here",
    "",
  ].map((v) => v.toLowerCase())
);

// Generous — this exists to catch "aaaaaaaa...", "12341234...", the
// literal variable name, not to be a rigorous randomness test.
const MIN_ENTROPY_BITS_PER_CHAR = 3.0;

function entropyBitsPerChar(value: string): number {
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function checkFlatSecret(name: string, value: string, minLength: number): string | null {
  if (KNOWN_PLACEHOLDER_VALUES.has(value.toLowerCase())) {
    return `${name} is still set to a documented .env.example placeholder value.`;
  }
  if (value.length < minLength) {
    return `${name} is ${value.length} characters — below the required minimum of ${minLength}.`;
  }
  if (entropyBitsPerChar(value) < MIN_ENTROPY_BITS_PER_CHAR) {
    return `${name} doesn't look like a genuinely random value (low character entropy).`;
  }
  return null;
}

function checkConnectionString(name: string, value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return `${name} is not a valid connection URI.`;
  }
  const password = decodeURIComponent(url.password ?? "");
  if (!password) {
    return `${name} has no embedded credential — production must never rely on trust/peer auth.`;
  }
  if (KNOWN_PLACEHOLDER_VALUES.has(password.toLowerCase()) || password.length < 12) {
    return `${name}'s embedded credential looks like a development placeholder.`;
  }
  if (["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
    return `${name} points at ${url.hostname} — production must never target a loopback address for its own DB/cache.`;
  }
  return null;
}

function buildPolicies(): SecretPolicy[] {
  return [
    { name: "AGENTGATE_JWT_SECRET", kind: "random-secret", minLength: 32, value: () => env.AGENTGATE_JWT_SECRET },
    { name: "AGENTGATE_PLATFORM_ENCRYPTION_KEY", kind: "hex-key", minLength: 64, value: () => env.AGENTGATE_PLATFORM_ENCRYPTION_KEY },
    { name: "AGENTGATE_API_KEY_PEPPER", kind: "random-secret", minLength: 32, value: () => env.AGENTGATE_API_KEY_PEPPER },
    { name: "AGENTGATE_INVITATION_TOKEN_SECRET", kind: "random-secret", minLength: 32, value: () => env.AGENTGATE_INVITATION_TOKEN_SECRET },
    {
      name: "AGENTGATE_SENDGRID_API_KEY",
      kind: "random-secret",
      minLength: 20,
      value: () => env.AGENTGATE_SENDGRID_API_KEY,
      appliesWhen: () => env.AGENTGATE_EMAIL_PROVIDER === "sendgrid",
    },
    { name: "AGENTGATE_DATABASE_URL", kind: "connection-string", value: () => env.AGENTGATE_DATABASE_URL },
    { name: "AGENTGATE_REDIS_URL", kind: "connection-string", value: () => env.AGENTGATE_REDIS_URL },
  ];
}

export function assertProductionSafety(): void {
  if (env.AGENTGATE_NODE_ENV !== "production") return;

  const failures: string[] = [];
  for (const policy of buildPolicies()) {
    if (policy.appliesWhen && !policy.appliesWhen()) continue;
    const raw = policy.value();
    if (!raw) { failures.push(`${policy.name} is missing.`); continue; }
    const problem =
      policy.kind === "connection-string"
        ? checkConnectionString(policy.name, raw)
        : checkFlatSecret(policy.name, raw, policy.minLength ?? 32);
    if (problem) failures.push(problem);
  }

  if (failures.length > 0) {
    console.error(
      "[production-safety-guard] Refusing to start — one or more secret-shaped variables " +
      "still look like development defaults:\n" + failures.map((f) => `  - ${f}`).join("\n")
    );
    process.exit(1);
  }
}