# AgentGate — Week 2 Roadmap
## Agent & Tool Registries, API Key Cryptography, Config Encryption (Milestone 2)

**Format:** Same as `roadmap_w1.md` — JIT learning block → build block → daily checkpoint.
**Difference from Week 1:** every build block below contains working code, not prose descriptions of code. Adapt file paths/imports to your actual codebase where noted; the logic and the reasoning behind it are the load-bearing part.

**What you already can't see from me, and how to handle it:** I don't have your exact `env.ts` beyond what's inferable from `app.ts`'s imports, your global error handler's exact shape (the Day 6 `setErrorHandler` fix), the exact return shape of your existing `createTestTenant()` factory, or 100% confirmation that `requireActiveIdentity` is wired into `app.ts`'s protected scope (the README describes it; the `app.ts` snapshot I was given doesn't show the registration line — check this on Day 1). Where any of this matters, the code below is flagged inline with a one-line comment. Nothing here should need more than a small adapter pass.

---

## Key Decisions & Deltas from HLD/PRD

Documenting these here, not just in chat, because this file is what you'll actually be looking at on Day 3 when you've forgotten why the encryption function looks the way it does. Matches your own `PROGRESS.md` philosophy — reasoning preserved next to outcomes.

| # | Decision | Why | Lands in |
|---|---|---|---|
| 1 | API key format is `agk.<keyId>.<secret>`, not a single opaque token | HLD's single-token design requires knowing `tenant_id` to look up the right hash — but `tenant_id` is what you're trying to establish. The only literal implementation is an O(n) argon2-verify sweep across all agents, and argon2 is deliberately slow. Splitting into a public `keyId` (indexed lookup) + secret (argon2-verified) fixes this. Must be decided now — changing key format later means reissuing every agent's key. | Day 1 |
| 2 | `handler_config` encryption uses a per-tenant HKDF-derived subkey, not the master key directly | Key separation / blast-radius reduction. Honestly: does not protect against a compromised master key (tenantId isn't secret). Defense-in-depth, not a boundary. | Day 3 |
| 3 | API key secrets are peppered before hashing (`AGENTGATE_API_KEY_PEPPER`), mirroring your password pepper | Consistency with established pattern; DB-only leak isn't enough to forge a key. | Day 1 |
| 4 | Encryption utility built **before** Tools CRUD — reversed vs. HLD's own listed sub-step order (2.4 before 2.6) | As speced, `createTool`'s first working version would write plaintext `handler_config`. Building the crypto first means that code path never exists. | Day 3 → Day 4/5 |
| 5 | Tools are deactivate-only (`isActive=false`), no hard-delete path exists at any layer | PRD §5.2 says "delete tools," but `tool_executions`/`audit_events` reference `tool_id` and must stay append-only (Week 5). A hard delete either orphans audit history or gets blocked by an FK and fails confusingly later. | Day 5 |
| 6 | `handler_config` is validated against a per-`handlerType` Zod discriminated union **before** encryption | Malformed configs get rejected at creation (`400`), not discovered as a runtime failure in Week 4's executor. | Day 4 |
| 7 | Every new repository mutation method requires `tenantId` in its `where` clause — no exceptions | Your Day 6 review flagged `updateVerified`/`updateRefreshTokenHash` for skipping this. Not repeating it on new ground. | Day 1, Day 4 |
| 8 | *(Forward note, not a Week 2 action)* Add `@@unique([agentId, toolId])` to `agent_tool_permissions` when it lands in Week 3 | Nothing today stops duplicate permission rows for the same pair. | Week 3 |

---

## Week 2 Dependency Chain

```
Day 1 (Schema: Agent model + API key format)
  │
  │  keyId/secret split must exist before any agent is
  │  ever created — retrofitting later means reissuing
  │  every existing key.
  │
  ▼
Day 2 (Agent Service + Routes + Rotation)
  │
  │  Full agent lifecycle proven. The CRUD + rotation
  │  pattern set here is reused as-is for tools on Day 5.
  │
  ▼
Day 3 (AES-256-GCM Encryption Utility)
  │
  │  Built BEFORE Tools CRUD (reordered vs. HLD's listed
  │  sub-step order) — createTool never has a plaintext-
  │  writing code path, not even transiently.
  │
  ▼
Day 4 (Schema: Tool model + handler_config /
        input_schema validation)
  │
  │  Validation exists before Day 5's createTool —
  │  garbage configs get a 400, not a Week 4 mystery.
  │
  ▼
Day 5 (Tool Service + Routes)
  │
  │  Mirrors Day 2's pattern: validate → encrypt →
  │  persist. Routes stay thin.
  │
  ▼
Day 6 (Integration Tests + Proof Checkpoint + Review)
  │
  │  Official Week 2 gates (ciphertext-not-plaintext,
  │  raw-key-shown-once) + cross-tenant isolation for
  │  both new entities. Must pass before Week 3.
  │
  ▼
Day 7 (Buffer + Hardening + PROGRESS.md + Week 3 Preview)
```

---

## Day 1 — Schema Foundations & the API Key Format Redesign

**Hours target:** 5–6h

### Concept Primer (read before coding, ~20 min)

**HKDF, in one paragraph.** HKDF (RFC 5869) turns one input key into any number of distinct output keys, deterministically, via two parameters: `salt` (a fixed, application-level constant — not secret, not random-per-call) and `info` (context-binding data, e.g. "this key is for tenant X, purpose Y"). Same master key + same salt + same info always produces the same output key. That's what makes it useful here: you don't store per-tenant keys anywhere, you *derive* them on demand from the master key + tenantId. Node has this built in as `crypto.hkdfSync()` — no new dependency. Full docs: https://nodejs.org/api/crypto.html (search "hkdfSync").

**Why `.` and not `_` as a key separator.** Both halves of the new API key are base64url-encoded random bytes. Base64url's alphabet is `A–Z a–z 0–9 - _` — it can legitimately contain underscores. A naive `token.split("_")` will occasionally produce more than 3 parts and silently mis-parse a fraction of generated keys — a bug that passes most manual testing and fails intermittently in production. `.` is not in the base64url alphabet, so it's always safe to split on — the same reason JWTs use `.` between their own base64url segments.

### Build Block

**Step 1 — Prisma schema addition (20 min)**

Add to `prisma/schema.prisma` (alongside your existing `Tenant`/`User` models — this is a delta, not a rewrite):

```prisma
model Agent {
  id           String    @id @default(uuid())
  tenantId     String    @map("tenant_id")
  name         String
  description  String?
  apiKeyId     String    @unique @map("api_key_id")
  apiKeyHash   String    @map("api_key_hash")
  isActive     Boolean   @default(true) @map("is_active")
  createdBy    String    @map("created_by")
  createdAt    DateTime  @default(now()) @map("created_at")
  updatedAt    DateTime  @updatedAt @map("updated_at")
  lastActiveAt DateTime? @map("last_active_at")

  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@unique([tenantId, name])
  @@index([tenantId])
  @@map("agents")
}
```

And add the back-reference to your existing `Tenant` model:

```prisma
model Tenant {
  // ...existing fields...
  users  User[]
  agents Agent[]   // ADD THIS LINE
}
```

`@@unique([tenantId, name])` isn't in the original PRD data model, but it mirrors the `slug` uniqueness you already have on `Tenant` and gives you a P2002 to catch (same pattern as your existing `registerTenant()` fix) instead of silently allowing confusing duplicate-named agents in a future dashboard.

Run the migration:

```bash
npx prisma migrate dev --name add_agents_table
npx prisma generate
```

Open your DB inspector and confirm the `agents` table exists with the expected columns before moving on.

**Step 2 — Env additions (10 min)**

Add to your Zod `envSchema` in `src/config/env.ts`:

```typescript
AGENTGATE_PLATFORM_ENCRYPTION_KEY: z.string().length(64), // 32-byte key, hex-encoded — used Day 3
AGENTGATE_API_KEY_PEPPER: z.string().min(32),
```

Generate a real key for local `.env` (never commit this):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**Step 3 — API key generation & hashing (`src/lib/api-key.ts`) (1h)**

```typescript
import crypto from "node:crypto";
import argon2 from "argon2";
import { env } from "../config/env.js";

/**
 * Agent API key format: agk.<keyId>.<secret>
 *
 * WHY a two-part key instead of one opaque token:
 * Argon2 hashes are salted per-hash — there is no way to query "find
 * the row whose hash matches this raw value." You can only verify a
 * raw value against ONE specific stored hash you already have. If
 * the only credential presented at connection time is a single
 * opaque secret, the only way to find which agent it belongs to is
 * to argon2.verify() against every active agent's hash until one
 * matches. argon2.verify() is deliberately slow (100-300ms) — fine
 * once at login, untenable across hundreds of agents on every SSE
 * connection attempt (Week 6).
 *
 * The fix: split the key into a PUBLIC lookup identifier (keyId —
 * not secret, stored and indexed in plaintext) and a SECRET portion
 * (argon2-hashed, verified only against the one row `keyId`
 * resolves to). Same shape as Stripe/GitHub/AWS API keys.
 *
 * WHY "." as the separator and not "_":
 * Both keyId and secret are base64url-encoded. Base64url's alphabet
 * is A-Z a-z 0-9 - _ — it can legitimately contain underscores. A
 * naive `token.split("_")` will sometimes produce more than 3 parts
 * and silently mis-parse a fraction of generated keys. "." is not
 * in the base64url alphabet, so `split(".")` is always safe — the
 * same reason JWTs separate their base64url segments with ".".
 */

const API_KEY_PREFIX = "agk";
const API_KEY_SEPARATOR = ".";
const KEY_ID_BYTES = 12; // -> 16 base64url chars, public, indexed
const SECRET_BYTES = 32; // -> 43 base64url chars, the actual secret

export interface GeneratedApiKey {
  keyId: string;
  rawSecret: string;
  fullKey: string; // shown to the user exactly once
}

export function generateApiKey(): GeneratedApiKey {
  const keyId = crypto.randomBytes(KEY_ID_BYTES).toString("base64url");
  const rawSecret = crypto.randomBytes(SECRET_BYTES).toString("base64url");
  const fullKey = [API_KEY_PREFIX, keyId, rawSecret].join(API_KEY_SEPARATOR);
  return { keyId, rawSecret, fullKey };
}

export interface ParsedApiKey {
  keyId: string;
  secret: string;
}

export function parseApiKey(token: string): ParsedApiKey | null {
  const parts = token.split(API_KEY_SEPARATOR);
  if (parts.length !== 3) return null;

  const [prefix, keyId, secret] = parts;
  if (prefix !== API_KEY_PREFIX || !keyId || !secret) return null;

  return { keyId, secret };
}

/**
 * Hashing mirrors your existing password pattern: pepper (from env,
 * never stored in the DB) + argon2. A DB-only leak (backup, replica,
 * a read-only SQL injection) is not enough to forge a working key —
 * the attacker also needs the pepper, which lives only in the app's
 * secret store/environment, never in Postgres.
 */
export async function hashApiKeySecret(secret: string): Promise<string> {
  return argon2.hash(secret + env.AGENTGATE_API_KEY_PEPPER);
}

export async function verifyApiKeySecret(
  hash: string,
  secret: string
): Promise<boolean> {
  return argon2.verify(hash, secret + env.AGENTGATE_API_KEY_PEPPER);
}
```

**Step 4 — Agent repository (`src/repositories/agent.repository.ts`) (45 min)**

```typescript
import { prisma } from "../lib/prisma.js";
import type { DbClient } from "../types/db-client.type.js"; // adjust import to your actual exported name if it differs

export const agentRepository = {
  create: (
    data: {
      tenantId: string;
      name: string;
      description?: string;
      apiKeyId: string;
      apiKeyHash: string;
      createdBy: string;
    },
    client: DbClient = prisma
  ) => client.agent.create({ data }),

  findById: (id: string, tenantId: string, client: DbClient = prisma) =>
    client.agent.findFirst({ where: { id, tenantId } }),

  /**
   * The ONE lookup in this repository that does not take tenantId.
   * This is intentional, not an oversight: at SSE-connection time
   * (Week 6), the caller does not know tenantId yet — that's what
   * we're trying to establish. `apiKeyId` is public (part of the
   * bearer token) but unguessable (96 bits of randomness) and
   * unique, so it's safe as the sole lookup key here. Everything
   * downstream must derive tenantId from the RETURNED ROW — never
   * from client input.
   */
  findByKeyId: (apiKeyId: string, client: DbClient = prisma) =>
    client.agent.findFirst({ where: { apiKeyId, isActive: true } }),

  list: (tenantId: string, client: DbClient = prisma) =>
    client.agent.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
    }),

  updateById: (
    id: string,
    tenantId: string,
    data: Partial<{ name: string; description: string; isActive: boolean }>,
    client: DbClient = prisma
  ) => client.agent.updateMany({ where: { id, tenantId }, data }),

  rotateKey: (
    id: string,
    tenantId: string,
    data: { apiKeyId: string; apiKeyHash: string },
    client: DbClient = prisma
  ) => client.agent.updateMany({ where: { id, tenantId }, data }),

  touchLastActive: (id: string, client: DbClient = prisma) =>
    client.agent.update({ where: { id }, data: { lastActiveAt: new Date() } }),
};
```

Note the `updateMany` choice for `updateById`/`rotateKey`: it returns `{count}` rather than the row, which lets the service layer distinguish "matched and updated" from "no row matched this (id, tenantId) pair" — the latter covers both "doesn't exist" and "belongs to another tenant," and those two cases should produce the *same* response (404) to the caller. Don't let the count-based check leak which case it was.

**Step 5 — Unit tests for the utility layer (45 min)**

`src/__tests__/api-key.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  generateApiKey,
  parseApiKey,
  hashApiKeySecret,
  verifyApiKeySecret,
} from "../lib/api-key.js";

describe("generateApiKey / parseApiKey", () => {
  it("round-trips: parsing a generated key recovers the same keyId and secret", () => {
    const generated = generateApiKey();
    const parsed = parseApiKey(generated.fullKey);
    expect(parsed).not.toBeNull();
    expect(parsed!.keyId).toBe(generated.keyId);
    expect(parsed!.secret).toBe(generated.rawSecret);
  });

  it("is robust across many generations (catches the base64url '_' edge case)", () => {
    // base64url output can legitimately contain "_" in either segment.
    // If the parser ever regresses to splitting on "_", this loop
    // will eventually generate a key that fails to round-trip.
    for (let i = 0; i < 500; i++) {
      const generated = generateApiKey();
      const parsed = parseApiKey(generated.fullKey);
      expect(parsed).toEqual({
        keyId: generated.keyId,
        secret: generated.rawSecret,
      });
    }
  });

  it("rejects tokens with the wrong prefix", () => {
    expect(parseApiKey("nope.abc.def")).toBeNull();
  });

  it("rejects malformed tokens (wrong segment count)", () => {
    expect(parseApiKey("agk.onlyonepart")).toBeNull();
    expect(parseApiKey("agk.a.b.c")).toBeNull();
  });
});

describe("hashApiKeySecret / verifyApiKeySecret", () => {
  it("verifies a correctly hashed secret", async () => {
    const { rawSecret } = generateApiKey();
    const hash = await hashApiKeySecret(rawSecret);
    await expect(verifyApiKeySecret(hash, rawSecret)).resolves.toBe(true);
  });

  it("rejects an incorrect secret", async () => {
    const a = generateApiKey();
    const b = generateApiKey();
    const hash = await hashApiKeySecret(a.rawSecret);
    await expect(verifyApiKeySecret(hash, b.rawSecret)).resolves.toBe(false);
  });
});
```

The 500-iteration loop test is the one worth paying attention to — it's specifically there to catch the underscore-splitting bug class, the same way your Week 1 rate-limiter concurrency test exists specifically to catch a race condition class, not just "test that it works once."

### ✅ Day 1 Checkpoint

- [ ] `agents` table exists with all expected columns; `npx prisma studio` shows it
- [ ] `AGENTGATE_PLATFORM_ENCRYPTION_KEY` and `AGENTGATE_API_KEY_PEPPER` added to `.env`, `.env.example`, and `envSchema`
- [ ] `npm test` passes the new `api-key.test.ts` suite, including the 500-iteration loop
- [ ] `npx tsc --noEmit` — zero errors

---

## Day 2 — Agent Service, Routes & Rotation

**Hours target:** 5h

### Build Block

**Step 1 — Agent service (`src/services/agent.service.ts`) (1.5h)**

```typescript
import { agentRepository } from "../repositories/agent.repository.js";
import { generateApiKey, hashApiKeySecret } from "../lib/api-key.js";

export const agentService = {
  async createAgent(
    tenantId: string,
    createdBy: string,
    input: { name: string; description?: string }
  ) {
    const { keyId, rawSecret, fullKey } = generateApiKey();
    const apiKeyHash = await hashApiKeySecret(rawSecret);

    try {
      const agent = await agentRepository.create({
        tenantId,
        name: input.name,
        description: input.description,
        apiKeyId: keyId,
        apiKeyHash,
        createdBy,
      });

      // fullKey is returned exactly once. It is never persisted,
      // logged, or retrievable through any other endpoint.
      return { agent: toPublicAgent(agent), apiKey: fullKey };
    } catch (err: any) {
      if (err.code === "P2002") {
        // Overwhelmingly likely to be the (tenantId, name) constraint.
        // A keyId collision is statistically negligible (1-in-2^96);
        // inspect err.meta?.target if you want to distinguish them.
        throw new Error("AGENT_NAME_TAKEN");
      }
      throw err;
    }
  },

  async listAgents(tenantId: string) {
    const agents = await agentRepository.list(tenantId);
    return agents.map(toPublicAgent);
  },

  async getAgent(id: string, tenantId: string) {
    const agent = await agentRepository.findById(id, tenantId);
    return agent ? toPublicAgent(agent) : null;
  },

  async updateAgent(
    id: string,
    tenantId: string,
    input: { name?: string; description?: string }
  ) {
    const { count } = await agentRepository.updateById(id, tenantId, input);
    if (count === 0) return null; // wrong tenant or doesn't exist — same response either way
    return this.getAgent(id, tenantId);
  },

  async deactivateAgent(id: string, tenantId: string) {
    const { count } = await agentRepository.updateById(id, tenantId, {
      isActive: false,
    });
    return count > 0;
  },

  async rotateApiKey(id: string, tenantId: string) {
    const existing = await agentRepository.findById(id, tenantId);
    if (!existing) return null;

    const { keyId, rawSecret, fullKey } = generateApiKey();
    const apiKeyHash = await hashApiKeySecret(rawSecret);

    const { count } = await agentRepository.rotateKey(id, tenantId, {
      apiKeyId: keyId,
      apiKeyHash,
    });
    if (count === 0) return null;

    // Old key is invalid the instant this write commits — no grace
    // period. Simpler, more secure MVP default; revisit only if you
    // have a concrete need for overlapping keys during rotation.
    return { apiKey: fullKey };
  },
};

// Never let apiKeyHash or apiKeyId leave the service layer.
function toPublicAgent(agent: {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  isActive: boolean;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  lastActiveAt: Date | null;
}) {
  const {
    id, tenantId, name, description, isActive,
    createdBy, createdAt, updatedAt, lastActiveAt,
  } = agent;
  return { id, tenantId, name, description, isActive, createdBy, createdAt, updatedAt, lastActiveAt };
}
```

**Step 2 — Routes (`src/routes/agents.ts`) (1h)**

```typescript
import type { FastifyInstance } from "fastify";
import { agentService } from "../services/agent.service.js";

/**
 * Registered INSIDE the existing protected scope in app.ts, so every
 * route here already has: authenticate -> attachTenantContext ->
 * requireActiveIdentity applied via Fastify's hook inheritance. Do
 * not re-add those hooks here — that would just run them twice.
 * Routes are defined relative to this plugin's own prefix ("/",
 * "/:id", ...), not "/agents/:id" — the prefix is supplied at
 * registration time in app.ts.
 */
export async function agentRoutes(app: FastifyInstance) {
  app.post(
    "/",
    {
      schema: {
        body: {
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string", minLength: 2, maxLength: 100 },
            description: { type: "string", maxLength: 500 },
          },
        },
      },
    },
    async (request, reply) => {
      const { tenantId, userId } = request.tenantContext;
      try {
        const result = await agentService.createAgent(tenantId, userId, request.body as any);
        return reply.status(201).send(result);
      } catch (err: any) {
        if (err.message === "AGENT_NAME_TAKEN") {
          return reply.conflict("An agent with this name already exists in this tenant");
        }
        throw err;
      }
    }
  );

  app.get("/", async (request) => {
    const { tenantId } = request.tenantContext;
    return agentService.listAgents(tenantId);
  });

  app.get("/:id", async (request, reply) => {
    const { tenantId } = request.tenantContext;
    const { id } = request.params as { id: string };
    const agent = await agentService.getAgent(id, tenantId);
    if (!agent) return reply.notFound();
    return agent;
  });

  app.patch(
    "/:id",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            name: { type: "string", minLength: 2, maxLength: 100 },
            description: { type: "string", maxLength: 500 },
          },
        },
      },
    },
    async (request, reply) => {
      const { tenantId } = request.tenantContext;
      const { id } = request.params as { id: string };
      const updated = await agentService.updateAgent(id, tenantId, request.body as any);
      if (!updated) return reply.notFound();
      return updated;
    }
  );

  app.delete("/:id", async (request, reply) => {
    const { tenantId } = request.tenantContext;
    const { id } = request.params as { id: string };
    const deactivated = await agentService.deactivateAgent(id, tenantId);
    if (!deactivated) return reply.notFound();
    return reply.status(204).send();
  });

  app.post("/:id/rotate-key", async (request, reply) => {
    const { tenantId } = request.tenantContext;
    const { id } = request.params as { id: string };
    const result = await agentService.rotateApiKey(id, tenantId);
    if (!result) return reply.notFound();
    return result;
  });
}
```

**Step 3 — Wire into `app.ts` (20 min)**

Inside your existing protected scope callback, alongside `/api/me` and `/api/me/details`:

```typescript
import { agentRoutes } from "./routes/agents.js";

// ...inside the protected scope registration:
await app.register(async (scope) => {
  scope.addHook("preHandler", authenticate);
  scope.addHook("preHandler", attachTenantContext);
  scope.addHook("preHandler", requireActiveIdentity); // confirm this line already exists — see the note at the top of this file

  scope.get("/api/me", /* ...unchanged... */);
  scope.get("/api/me/details", /* ...unchanged... */);

  // Week 2 addition:
  await scope.register(agentRoutes, { prefix: "/api/agents" });
});
```

**Step 4 — Manual verification (30 min)**

```bash
# Create an agent
curl -X POST http://localhost:3000/api/agents \
  -H "Authorization: Bearer <access_token>" \
  -H "Content-Type: application/json" \
  -d '{"name": "billing-agent", "description": "Reads invoice status"}'

# Response includes: { "agent": {...}, "apiKey": "agk.xxxx.yyyy" }
# Copy the apiKey now — it will never be shown again.

# Confirm it's gone from a subsequent GET
curl http://localhost:3000/api/agents/<agent_id> \
  -H "Authorization: Bearer <access_token>"
# Should NOT contain apiKey, apiKeyHash, or apiKeyId anywhere in the response

# Rotate and confirm the old key format still parses but is now invalid
curl -X POST http://localhost:3000/api/agents/<agent_id>/rotate-key \
  -H "Authorization: Bearer <access_token>"
```

**Step 5 — Tests (1h)**

Cover, using `app.inject()` as established in Week 1:

```typescript
describe("Agent CRUD", () => {
  it("creates an agent and returns the raw API key exactly once")
  it("raw API key is absent from the create response's `agent` object (only in the sibling `apiKey` field)")
  it("raw API key never reappears on subsequent GET /api/agents/:id")
  it("stores an argon2 hash — not the plaintext secret — in api_key_hash")
  it("returns 409 when creating a second agent with the same name in the same tenant")
  it("returns 404 for GET /api/agents/:id on a nonexistent id")
  it("PATCH updates name/description")
  it("DELETE deactivates (isActive=false) rather than removing the row")
  it("rotate-key issues a new key and invalidates the old one")
  it("returns 400 when name is missing or too short")
})
```

### ✅ Day 2 Checkpoint

- [ ] Full agent lifecycle works via curl: create → get → patch → rotate-key → delete (deactivate)
- [ ] Raw API key appears in exactly one response, ever
- [ ] Cross-tenant note: you don't have a second tenant to test isolation against yet in an automated way beyond what Week 1 already proves for `/api/me` — the dedicated agent/tool cross-tenant tests land Day 6 once both entities exist
- [ ] `npm test` passes

---

## Day 3 — AES-256-GCM Encryption Utility (Per-Tenant Key Derivation)

**Hours target:** 5–6h — this is the most security-critical day this week, budget accordingly, same as Week 1 treated its TenantContext day.

### Concept Primer (~30 min)

**AES-256-GCM's auth tag, briefly (you may already have this from the original plan).** GCM is authenticated encryption: alongside the ciphertext, it produces a 16-byte auth tag. Decryption recomputes the tag and compares — if it doesn't match (tampered ciphertext, wrong key, wrong IV, corrupted data), decryption throws instead of silently returning garbage. This is the mechanism that makes the "tamper detection" test below actually mean something; you're not implementing tamper detection, GCM gives it to you for free as long as you always call `setAuthTag()` before `decipher.final()`.

**HKDF salt vs. info — the textbook-correct split.** RFC 5869 defines two extraction/expansion parameters: `salt` (fixed or omitted, application-level) and `info` (context-binding, varies per use). For deterministic per-tenant subkeys, tenantId belongs in `info` (it's the context you're binding to), while `salt` should be a fixed, unique-to-this-purpose constant. Getting these backwards still "works" cryptographically, but mixing up which parameter does which job makes the code harder to reason about later and out of step with how every reference implementation does it.

### Build Block

**Step 1 — Encryption utility (`src/lib/encryption.ts`) (1.5h)**

```typescript
import crypto from "node:crypto";
import { env } from "../config/env.js";

/**
 * Per-tenant envelope encryption for `tools.handler_config`.
 *
 * The HLD/PRD spec a single platform-wide AES-256-GCM key
 * (AGENTGATE_PLATFORM_ENCRYPTION_KEY) used directly to encrypt every
 * tenant's handler_config. That works, but every tenant's secrets
 * share one working key: a narrow leak of a derived/working key in
 * one code path (a debug log, a bug scoped to one request) exposes
 * every tenant, not just the one being processed at the time.
 *
 * This version derives a distinct subkey per tenant via HKDF
 * (RFC 5869) from the same master key, and uses the SUBKEY — never
 * the master key directly — for AES-256-GCM. Be precise about what
 * this buys you: tenantId is not secret (it's in JWTs, URLs, audit
 * logs), so this is NOT a boundary against compromise of the master
 * key itself — anyone with the master key can re-derive any
 * tenant's subkey on demand. What it DOES buy: key separation as a
 * matter of hygiene, a narrower blast radius for a leak scoped to
 * one request/tenant, and a schema-free path to future per-tenant
 * key rotation or BYOK if you ever want it. Treat it as
 * defense-in-depth, not a silver bullet.
 */

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // 96-bit IV — recommended size for GCM
const KEY_BYTES = 32; // AES-256
const HKDF_SALT = Buffer.from("agentgate-hkdf-salt-v1", "utf8"); // fixed, application-level domain separator — NOT random-per-call
const HKDF_INFO_PREFIX = "handler-config-v1:"; // + tenantId — binds the derived key to this tenant AND this use case

function deriveTenantKey(tenantId: string): Buffer {
  const masterKey = Buffer.from(env.AGENTGATE_PLATFORM_ENCRYPTION_KEY, "hex");
  if (masterKey.length !== KEY_BYTES) {
    throw new Error(
      `AGENTGATE_PLATFORM_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes (got ${masterKey.length})`
    );
  }
  const info = Buffer.from(HKDF_INFO_PREFIX + tenantId, "utf8");
  return Buffer.from(crypto.hkdfSync("sha256", masterKey, HKDF_SALT, info, KEY_BYTES));
}

/**
 * Stored format: "<iv>:<ciphertext>:<authTag>", each segment base64.
 * ":" is a safe separator here because standard base64 (RFC 4648,
 * with padding) never contains ":".
 */
export function encryptConfig(plaintext: string, tenantId: string): string {
  const key = deriveTenantKey(tenantId);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    iv.toString("base64"),
    ciphertext.toString("base64"),
    authTag.toString("base64"),
  ].join(":");
}

export function decryptConfig(stored: string, tenantId: string): string {
  const segments = stored.split(":");
  if (segments.length !== 3) {
    throw new Error("Malformed ciphertext envelope");
  }
  const [ivB64, ciphertextB64, authTagB64] = segments;

  const key = deriveTenantKey(tenantId);
  const iv = Buffer.from(ivB64, "base64");
  const ciphertext = Buffer.from(ciphertextB64, "base64");
  const authTag = Buffer.from(authTagB64, "base64");

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  // Throws if the auth tag doesn't match — tampered ciphertext,
  // wrong tenantId at decrypt time, or corrupted data. This is
  // GCM's integrity check, not something implemented here.
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}
```

**Step 2 — Tests (1h) — `src/__tests__/encryption.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { encryptConfig, decryptConfig } from "../lib/encryption.js";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";

describe("encryptConfig / decryptConfig", () => {
  it("round-trips plaintext for the same tenant", () => {
    const plaintext = JSON.stringify({ url: "https://internal.example.com", method: "POST" });
    const stored = encryptConfig(plaintext, TENANT_A);
    expect(stored).not.toContain("internal.example.com"); // not plaintext at rest
    expect(decryptConfig(stored, TENANT_A)).toBe(plaintext);
  });

  it("produces a different ciphertext every time (random IV)", () => {
    const plaintext = "same input twice";
    const first = encryptConfig(plaintext, TENANT_A);
    const second = encryptConfig(plaintext, TENANT_A);
    expect(first).not.toBe(second);
  });

  it("fails to decrypt with a different tenant's derived key", () => {
    const stored = encryptConfig("tenant A's secret connection string", TENANT_A);
    expect(() => decryptConfig(stored, TENANT_B)).toThrow();
  });

  it("detects tampering via the GCM auth tag", () => {
    const stored = encryptConfig("do not touch this", TENANT_A);
    const [iv, ciphertext, authTag] = stored.split(":");
    const tamperedCiphertext = Buffer.from(ciphertext, "base64");
    tamperedCiphertext[0] ^= 0xff; // flip a bit
    const tampered = [iv, tamperedCiphertext.toString("base64"), authTag].join(":");
    expect(() => decryptConfig(tampered, TENANT_A)).toThrow();
  });

  it("rejects a malformed envelope", () => {
    expect(() => decryptConfig("not-a-valid-envelope", TENANT_A)).toThrow();
  });
});
```

The `TENANT_B` test is the one that actually proves the HKDF derivation is doing something — without it, you'd have a correct AES-GCM implementation but no evidence the "per-tenant" part of "per-tenant key derivation" is real.

### ✅ Day 3 Checkpoint

- [ ] Roundtrip test passes
- [ ] Tamper test passes (flipped byte causes a throw, not silent corruption)
- [ ] Cross-tenant derived-key test passes (proves key separation is real, not just declared)
- [ ] `AGENTGATE_PLATFORM_ENCRYPTION_KEY` validated at startup (via your existing env.ts fail-fast pattern) — a misconfigured key should crash the process immediately, not fail confusingly on the first tool creation

---

# AgentGate — Week 2 Roadmap Revision: Days 4, 5 & 6

**Supersedes:** `roadmap_w2.md` Days 4–6 only. **Days 1–3 stand as originally written and already completed** — nothing here touches the Agent CRUD, API key pipeline, or AES-256-GCM/HKDF encryption work you've already shipped and checkpointed.

**Why this revision exists:** `handler_config` and `input_schema` are the two places tenant-authored input becomes something the platform itself later *executes* (Week 4) or *compiles and runs repeatedly* (Week 6, on the `tools/call` hot path). A gap here isn't a Week 2 bug — it's a standing weakness in the trust boundary the HLD itself calls "the most dangerous module in the system." This revision closes three real gaps found in review before either downstream consumer exists to obscure the root cause:

1. **A repository bug** (`setActiveStatus` targeting the wrong Prisma model) that would have silently broken tool deactivation.
2. **SSRF exposure** — tenant-controlled URLs/connection strings can currently target the platform's own internal infrastructure, cloud metadata endpoints, or other tenants' networks.
3. **A ReDoS exposure** unique to this system — tenant-authored regex `pattern` values in `input_schema` get compiled and run by AJV against every `tools/call` argument, forever, in Week 6. Unlike your I/O handlers (Week 4), a hung synchronous regex match **cannot be cancelled by `AbortController`** — there is no timeout escape hatch once V8 starts backtracking. This makes Day 4's pattern-safety gate a hard requirement, not a nice-to-have.

**Verified, not assumed** (relevant since you asked for correct-over-cheap): before writing this revision, I installed the two new dependencies below in a scratch environment and empirically confirmed —
- Node 22's native `URL` parser normalizes decimal/hex/octal-encoded IP obfuscation (`2130706433`, `0x7f000001`, `017700000001`) to plain dotted-decimal *before* any range-classification logic ever runs — closing the most common SSRF string-bypass class at zero extra code cost.
- `169.254.169.254` (the cloud metadata IP most SSRF exploits target) falls under `ipaddr.js`'s `linkLocal` classification automatically — no special case needed.
- IPv6 literals come back from `URL.hostname` bracketed (e.g. `[::1]`) and must be stripped before classification — handled below.
- `safe-regex` reliably flags nested-quantifier ReDoS patterns (`(a+)+`, `(a*)*`) and produces **zero false positives** against realistic tool-schema patterns (email, UUID, phone, bounded alternation). It does **not** flag milder ambiguous-alternation patterns (`(a|a)+`) — an honest, documented gap, not a silent one.

---

## New Dependencies

```bash
npm install ipaddr.js safe-regex
npm install --save-dev @types/safe-regex
```

`ipaddr.js` ships its own bundled TypeScript types (`@types/ipaddr.js` does not exist and is not needed — installing it would actually fail). `safe-regex` ships no types of its own; `@types/safe-regex` exists on DefinitelyTyped (confirmed at v1.1.6) and covers it.

Both are CommonJS packages with a default export, same shape as `argon2` — your own `api-key.ts` already does `import argon2 from "argon2"`, so the same interop pattern applies here without any tsconfig changes.

---

## New Shared Modules — Where They Live and Why

| Module | Responsibility | Reused in |
|---|---|---|
| `src/lib/network-safety.ts` | Layer 1 SSRF pre-filter: scheme allow-list + hostname/IP range classification | Day 4 schema validation now; **Week 4's executor imports the same `checkHostnameSafety` logic** for the authoritative DNS-resolution-time check |
| `src/lib/schema-safety.ts` | Complexity ceiling + regex pattern safety scan for tenant `input_schema` | Day 4 `schema-validator.ts` only |

Both are pure, dependency-free functions — no DB, no I/O — independently unit-testable, matching the discipline you already applied to `checkPermission()`.

---

# Day 4 — Tool Schema, `handler_config` Shape+Safety Validation, `input_schema` Well-Formedness+Safety Validation

**Hours target:** 7–8h (up from the original 5h — this is now a second critical security day, budget it like Day 3). If it runs into Day 5's morning, that's the correct outcome, not a scheduling failure.

### Concept Primer (~30 min read before coding)

**Why SSRF gets a two-layer design, not one.** String-level validation at tool-creation time (this layer) can only catch what's visible in the string itself. A hostname like `internal-db.corp` reveals nothing dangerous until DNS resolves it — and that resolution can differ between this check and the actual connection later (DNS rebinding). So Layer 1 here is a **pre-filter**, not the boundary. The **authoritative** check — resolve, then validate the *resolved IP*, on every single call — belongs in Week 4's `executeTool()`, wired into the HTTP client's DNS lookup step. Document this distinction explicitly in code comments; it's the kind of thing that's obvious today and easy to forget was ever a deliberate scoping decision by Week 4.

**Why regex pattern safety is not optional, architecturally.** Your `withTimeout()` / `AbortController` pattern (Week 4) works because the operations it wraps — HTTP calls, Postgres queries — are asynchronous I/O that Node's event loop can walk away from when a signal fires. A regex match is **synchronous**. Once `RegExp.prototype.test()` starts backtracking on a catastrophic pattern, it owns the single JS thread until it finishes — there is no `AbortSignal` integration point, no way to time out a hung regex match without something far heavier (a Worker thread you forcibly `.terminate()`). That means Gate 3 below isn't "extra hardening" — for this specific failure mode, it is the *only* defense that exists anywhere in the system. Internalize this before treating the pattern scan as a box-ticking exercise.

**On `safe-regex`'s honest limits.** It's a heuristic (star-height analysis), not a proof. It reliably catches the dominant real-world ReDoS shape — nested/repeated quantifiers — and it does so with zero false positives on the kinds of patterns a legitimate tool schema would actually contain. It will *not* catch every theoretically pathological pattern (confirmed: it lets `(a|a)+` through). Track this as a named, accepted limitation, not a solved problem — see the `PROGRESS.md` note at the end of this document.

---

### Step 1 — Prisma Schema Addition (15 min, unchanged from original plan)

```prisma
model Tool {
  id            String   @id @default(uuid())
  tenantId      String   @map("tenant_id")
  name          String
  description   String?
  category      String?
  handlerType   String   @map("handler_type")
  handlerConfig String   @map("handler_config") // ciphertext: "iv:ciphertext:authTag"
  inputSchema   Json     @map("input_schema")
  outputSchema  Json?    @map("output_schema")
  isActive      Boolean  @default(true) @map("is_active")
  createdAt     DateTime @default(now()) @map("created_at")
  updatedAt     DateTime @updatedAt @map("updated_at")

  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@unique([tenantId, name])
  @@index([tenantId])
  @@map("tools")
}
```

Add `tools Tool[]` to your `Tenant` model's relation block (same as `agents` on Day 1).

```bash
npx prisma migrate dev --name add_tools_table
npx prisma generate
```

---

### Step 2 — Fix the Repository Bug First (10 min)

Before writing anything new: your uploaded `tool.repository.ts` has one line that must change before you build on top of it.

```typescript
// ❌ BEFORE — targets the wrong Prisma model entirely
setActiveStatus: (
    id: string,
    tenantId: string,
    isActive: boolean,
    client: DbClient = prisma
  ) => client.agent.updateMany({ where: { id, tenantId }, data: { isActive } }
  ),
```

```typescript
// ✅ AFTER
setActiveStatus: (
    id: string,
    tenantId: string,
    isActive: boolean,
    client: DbClient = prisma
  ) => client.tool.updateMany({ where: { id, tenantId }, data: { isActive } }),
```

**Why this matters beyond "it's a bug":** `client.agent.updateMany` run with a tool's `id` matches zero rows against the `agents` table essentially every time — so every deactivation attempt would have silently reported "not found" (`count === 0` → your service layer already returns `null`/404 for that case) even when the tool genuinely exists and belongs to the caller. This is exactly the failure class your `updateProfile`/`setActiveStatus` split was designed to prevent at compile time — but the type system only catches *shape* bugs, not *routing* bugs (wrong Prisma delegate). Only a same-named-method test across both repository files catches this class; see Day 6's new test for exactly that.

---

### Step 3 — `src/lib/network-safety.ts` (1.5h)

```typescript
import ipaddr from "ipaddr.js";

/**
 * Layer 1 of a two-layer SSRF defense (see Day 4 concept primer in
 * roadmap_w2_days_4-6_REVISED.md).
 *
 * This module answers ONE question: "does this URL/hostname obviously
 * point somewhere it shouldn't, based on the string alone?" It runs
 * once, at tool create/update time — off the hot path entirely.
 *
 * It is explicitly NOT the authoritative boundary. A hostname like
 * "internal-db.corp" reveals nothing dangerous as a string; it only
 * becomes dangerous once DNS resolves it to a private IP, and that
 * resolution can change between this check and the actual connection
 * (DNS rebinding). The authoritative check — resolve, THEN validate
 * the resolved IP, on every call — belongs in Week 4's executeTool(),
 * wired into the HTTP client's own DNS lookup step. checkHostnameSafety
 * below is written to be re-imported there unchanged; only the "when"
 * differs between the two call sites.
 */

const ALLOWED_HTTP_SCHEMES = new Set(["http:", "https:"]);
const ALLOWED_POSTGRES_SCHEMES = new Set(["postgres:", "postgresql:"]);

// Named explicitly even though most of these are already covered by
// the range-classification block below — kept as a literal blocklist
// for readability, and as a safety net if a future ipaddr.js version
// ever reclassifies a range. These are HOSTNAMES, not IPs, so the
// range classifier can't catch them at all.
const BLOCKED_LITERAL_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal", // GCP metadata hostname alias
]);

// ipaddr.js range() classifications that must never be reachable from
// a tenant-configured tool. "linkLocal" covers 169.254.0.0/16, which
// includes 169.254.169.254 — the cloud metadata endpoint targeted by
// almost every real-world SSRF exploit — with no special case needed.
const BLOCKED_IP_RANGES = new Set([
  "private",         // RFC 1918 (10/8, 172.16/12, 192.168/16)
  "loopback",        // 127.0.0.0/8, ::1
  "linkLocal",       // 169.254.0.0/16 — cloud metadata range
  "uniqueLocal",     // IPv6 equivalent of RFC 1918 (fc00::/7)
  "reserved",
  "carrierGradeNat", // 100.64.0.0/10
  "unspecified",     // 0.0.0.0, ::
]);

export interface SafetyCheckResult {
  safe: boolean;
  reason?: string;
}

/**
 * Classifies a hostname or literal IP. Handles both plain hostnames
 * and literal IPs in any form the WHATWG URL parser has already
 * canonicalized to dotted-decimal (verified empirically against
 * decimal/hex/octal-encoded loopback variants — Node 22's URL parser
 * normalizes all of them before this function ever runs).
 */
function checkHostnameSafety(rawHostname: string): SafetyCheckResult {
  // WHATWG URL.hostname wraps IPv6 literals in brackets (e.g. "[::1]").
  // ipaddr.js expects the bare address — strip brackets here, the one
  // shared place both call sites below funnel through.
  const hostname = rawHostname.replace(/^\[|\]$/g, "");
  const normalized = hostname.toLowerCase();

  if (BLOCKED_LITERAL_HOSTNAMES.has(normalized)) {
    return { safe: false, reason: `hostname "${hostname}" is explicitly blocked` };
  }

  if (!ipaddr.isValid(normalized)) {
    // Not a literal IP — a real hostname. We cannot know what it
    // resolves to without a DNS lookup, and a check-then-use pattern
    // here is beatable by DNS rebinding anyway. This is exactly why
    // Layer 2 exists in Week 4. Layer 1 passes it through.
    return { safe: true };
  }

  // ipaddr.process() unifies IPv4-mapped IPv6 forms (e.g.
  // "::ffff:127.0.0.1") with their IPv4 equivalent before
  // classifying — without this step, that exact string classifies as
  // generic IPv6 "unicast" and slips through as "safe."
  const parsed = ipaddr.process(normalized);
  const range = parsed.range();

  if (BLOCKED_IP_RANGES.has(range)) {
    return { safe: false, reason: `hostname "${hostname}" resolves to a ${range} address` };
  }

  return { safe: true };
}

/**
 * Validates an http(s) / web-fetch URL: scheme allow-list + hostname
 * safety.
 */
export function checkHttpUrlSafety(rawUrl: string): SafetyCheckResult {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { safe: false, reason: "not a valid URL" };
  }

  if (!ALLOWED_HTTP_SCHEMES.has(parsed.protocol)) {
    return { safe: false, reason: `scheme "${parsed.protocol}" is not allowed (only http/https)` };
  }

  return checkHostnameSafety(parsed.hostname);
}

/**
 * Validates a Postgres connection string.
 *
 * MVP scope: single-host URI form only
 * ("postgresql://user:pass@host:port/db"). Multi-host failover
 * strings ("host1:5432,host2:5432") are explicitly rejected as
 * malformed rather than silently validated against only the first
 * host — an unvalidated second host would be a silent gap, not a
 * convenience. If multi-host support becomes a real requirement
 * later, extend this function deliberately; don't work around it at
 * a call site.
 */
export function checkPostgresConnectionStringSafety(raw: string): SafetyCheckResult {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { safe: false, reason: "not a valid connection URI (single-host postgresql:// form required)" };
  }

  if (!ALLOWED_POSTGRES_SCHEMES.has(parsed.protocol)) {
    return { safe: false, reason: `scheme "${parsed.protocol}" is not allowed (only postgres/postgresql)` };
  }

  if (parsed.hostname.includes(",")) {
    return { safe: false, reason: "multi-host connection strings are not supported" };
  }

  return checkHostnameSafety(parsed.hostname);
}
```

---

### Step 4 — `src/lib/schema-safety.ts` (1.5h)

```typescript
import safeRegex from "safe-regex";

/**
 * Gates 2 and 3 for tenant-submitted input_schema (Gate 1 —
 * structural JSON Schema validity — lives in schema-validator.ts).
 *
 * Both gates exist because Week 6 will ajv.compile() and RUN every
 * stored input_schema against every tools/call argument, forever, on
 * the hot path. A regex match is synchronous and cannot be cancelled
 * by AbortController once it starts backtracking — unlike the async
 * I/O handlers in Week 4, there is no timeout escape hatch for a
 * hung pattern. That makes this gate the only defense against that
 * specific failure mode anywhere in the system.
 */

const MAX_SCHEMA_SERIALIZED_LENGTH = 20_000; // generous for a real tool's parameter list
const MAX_SCHEMA_DEPTH = 10;                  // generous for realistic nested objects/arrays
const MAX_PATTERN_LENGTH = 200;               // most ReDoS-vulnerable patterns need repetition to express, which needs length

export interface SchemaSafetyResult {
  safe: boolean;
  errors?: string[];
}

export function checkSchemaComplexity(schema: unknown): SchemaSafetyResult {
  const serialized = JSON.stringify(schema);
  if (serialized === undefined) {
    return { safe: false, errors: ["schema could not be serialized"] };
  }
  if (serialized.length > MAX_SCHEMA_SERIALIZED_LENGTH) {
    return {
      safe: false,
      errors: [`schema exceeds maximum size of ${MAX_SCHEMA_SERIALIZED_LENGTH} characters`],
    };
  }

  const depth = measureDepth(schema);
  if (depth > MAX_SCHEMA_DEPTH) {
    return {
      safe: false,
      errors: [`schema nesting depth (${depth}) exceeds maximum of ${MAX_SCHEMA_DEPTH}`],
    };
  }

  return { safe: true };
}

function measureDepth(value: unknown, current = 0): number {
  // Bail out rather than recursing arbitrarily deep on a pathological
  // input — we only need to know "too deep," not the exact number
  // once already well past the ceiling.
  if (current > MAX_SCHEMA_DEPTH + 5) return current;

  if (Array.isArray(value)) {
    let max = current;
    for (const v of value) max = Math.max(max, measureDepth(v, current + 1));
    return max;
  }
  if (value && typeof value === "object") {
    let max = current;
    for (const v of Object.values(value as Record<string, unknown>)) {
      max = Math.max(max, measureDepth(v, current + 1));
    }
    return max;
  }
  return current;
}

/**
 * Recursively collects every `pattern` value and every
 * `patternProperties` KEY (the pattern there is the object's keys,
 * not its values) anywhere in a JSON Schema tree, then runs each
 * through safe-regex's static backtracking analysis.
 *
 * safe-regex is a heuristic, not a formal proof. Empirically verified:
 * it reliably flags nested-quantifier constructs (`(a+)+`, `(a*)*`)
 * with zero false positives against realistic patterns (email, UUID,
 * phone, bounded alternation). It does NOT flag every theoretically
 * pathological pattern (confirmed miss: ambiguous alternation like
 * `(a|a)+`). This is a named, accepted limitation — see PROGRESS.md.
 */
export function scanForUnsafePatterns(schema: unknown): SchemaSafetyResult {
  const patterns = collectPatterns(schema);
  const errors: string[] = [];

  for (const pattern of patterns) {
    if (pattern.length > MAX_PATTERN_LENGTH) {
      errors.push(`pattern exceeds maximum length of ${MAX_PATTERN_LENGTH} characters: "${pattern.slice(0, 40)}..."`);
      continue;
    }

    // Distinguish "not a valid regex at all" from "valid but unsafe" —
    // both get rejected, but the message should tell a tenant which
    // problem they actually have.
    try {
      new RegExp(pattern);
    } catch {
      errors.push(`pattern is not a syntactically valid regular expression: "${pattern}"`);
      continue;
    }

    if (!safeRegex(pattern)) {
      errors.push(`pattern flagged as a potential catastrophic-backtracking risk: "${pattern}"`);
    }
  }

  return errors.length > 0 ? { safe: false, errors } : { safe: true };
}

function collectPatterns(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectPatterns(item, found);
  } else if (value && typeof value === "object") {
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (key === "pattern" && typeof val === "string") {
        found.push(val);
      }
      if (key === "patternProperties" && val && typeof val === "object") {
        for (const patternKey of Object.keys(val as Record<string, unknown>)) {
          found.push(patternKey);
        }
      }
      collectPatterns(val, found);
    }
  }
  return found;
}
```

---

### Step 5 — `src/lib/handler-config.schema.ts` (revised) (1.5h)

```typescript
import { z } from "zod";
import { checkHttpUrlSafety, checkPostgresConnectionStringSafety } from "./network-safety.js";

/**
 * Validates the SHAPE + SAFETY of handler_config against the declared
 * handlerType, before it is ever encrypted or stored.
 *
 * Two distinct concerns, both gated here:
 *  1. Shape   — does this object have the fields the handlerType needs?
 *  2. Safety  — do url/connectionString/headers point somewhere, or
 *     contain something, the platform should refuse to store — given
 *     that this config will later be DECRYPTED AND EXECUTED against
 *     real systems by the platform process itself (Week 4)?
 *
 * The safety checks are Layer 1 of the two-layer SSRF defense — see
 * network-safety.ts for why Layer 2 (DNS-resolution-time, in the
 * Week 4 executor) is the actual authoritative boundary.
 *
 * .strict() on every variant below is deliberate, not decorative: it
 * makes a config that blends fields from two different handler types
 * (e.g. handlerType "http" carrying a stray `connectionString`) fail
 * validation outright instead of silently having the extra field
 * stripped — the exact AJV `removeAdditional` lesson from Week 1,
 * applied here to Zod.
 */

const MAX_CONFIG_STRING_LENGTH = 8_000; // generous for a real query/template/connection string; this gets AES-GCM encrypted and held in memory per invocation, so unbounded input is a resource-exhaustion vector, not just a correctness nit

// Header names an HTTP client sets itself from connection/framing
// state. Letting a tenant override these can corrupt or smuggle the
// request the platform makes on its own behalf.
const FORBIDDEN_HEADER_NAMES = new Set(["host", "content-length", "transfer-encoding", "connection"]);

// Raw CR/LF in a header value is the classic header-injection /
// response-splitting primitive. Most modern HTTP clients reject these
// internally, but validating here rejects a malformed config at
// CREATE time with a clear 400, instead of a cryptic Week 4 runtime error.
const CRLF_PATTERN = /[\r\n]/;

const safeHeaders = z
  .record(z.string())
  .optional()
  .refine(
    (headers) => {
      if (!headers) return true;
      return Object.entries(headers).every(
        ([key, value]) => !FORBIDDEN_HEADER_NAMES.has(key.toLowerCase()) && !CRLF_PATTERN.test(value)
      );
    },
    { message: "headers must not override connection-level fields (Host, Content-Length, Transfer-Encoding, Connection) or contain CR/LF characters" }
  );

const safeHttpUrl = z
  .string()
  .max(MAX_CONFIG_STRING_LENGTH)
  .url()
  .superRefine((url, ctx) => {
    const result = checkHttpUrlSafety(url);
    if (!result.safe) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: result.reason ?? "URL target is not allowed" });
    }
  });

const safeConnectionString = z
  .string()
  .min(1)
  .max(MAX_CONFIG_STRING_LENGTH)
  .superRefine((cs, ctx) => {
    const result = checkPostgresConnectionStringSafety(cs);
    if (!result.safe) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: result.reason ?? "connection target is not allowed" });
    }
  });

export const httpHandlerConfigSchema = z
  .object({
    handlerType: z.literal("http"),
    url: safeHttpUrl,
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    headers: safeHeaders,
    bodyTemplate: z.string().max(MAX_CONFIG_STRING_LENGTH).optional(),
  })
  .strict();

export const postgresHandlerConfigSchema = z
  .object({
    handlerType: z.literal("postgres"),
    connectionString: safeConnectionString,
    query: z.string().min(1).max(MAX_CONFIG_STRING_LENGTH),
  })
  .strict();

export const webFetchHandlerConfigSchema = z
  .object({
    handlerType: z.literal("web_fetch"),
    url: safeHttpUrl,
  })
  .strict();

export const handlerConfigSchema = z.discriminatedUnion("handlerType", [
  httpHandlerConfigSchema,
  postgresHandlerConfigSchema,
  webFetchHandlerConfigSchema,
]);

export type HandlerConfig = z.infer<typeof handlerConfigSchema>;
```

> **Note on Zod version:** the code above assumes the single-argument `z.record(z.string())` form (Zod 3.x). If you're on Zod 4, this signature changed to require an explicit key schema (`z.record(z.string(), z.string())`) — a compile error will tell you immediately if that's the case; it's a one-argument fix.

---

### Step 6 — `src/lib/schema-validator.ts` (revised) (30 min)

```typescript
import Ajv from "ajv";
import { checkSchemaComplexity, scanForUnsafePatterns } from "./schema-safety.js";

/**
 * Validates that a TENANT-SUBMITTED input_schema is well-formed,
 * bounded, and safe to compile+run repeatedly later (Week 6, on the
 * tools/call hot path). Three gates, cheapest-first:
 *
 *   1. Structural validity — is this a syntactically valid JSON Schema?
 *   2. Complexity ceiling  — small/shallow enough to be a real tool
 *      parameter list, not a resource-exhaustion attempt?
 *   3. Pattern safety      — do any pattern/patternProperties values
 *      risk catastrophic backtracking when Week 6 compiles and
 *      repeatedly runs them?
 *
 * This does NOT validate actual tool-call arguments against the
 * schema (that's Week 6's ajv.compile() at invocation time) — it only
 * guards what gets stored.
 */
const ajv = new Ajv({ allErrors: true, strict: false });

export interface SchemaValidationResult {
  valid: boolean;
  errors?: string[];
  failedGate?: "structural" | "complexity" | "pattern_safety";
}

export function validateJsonSchema(schema: unknown): SchemaValidationResult {
  try {
    const structurallyValid = ajv.validateSchema(schema);
    if (!structurallyValid) {
      return {
        valid: false,
        failedGate: "structural",
        errors: (ajv.errors ?? []).map((e) => `${e.instancePath || "(root)"} ${e.message}`),
      };
    }
  } catch {
    return {
      valid: false,
      failedGate: "structural",
      errors: ["schema could not be parsed as a valid JSON Schema"],
    };
  }

  const complexity = checkSchemaComplexity(schema);
  if (!complexity.safe) {
    return { valid: false, failedGate: "complexity", errors: complexity.errors };
  }

  const patternSafety = scanForUnsafePatterns(schema);
  if (!patternSafety.safe) {
    return { valid: false, failedGate: "pattern_safety", errors: patternSafety.errors };
  }

  return { valid: true };
}
```

---

### Step 7 — Tests (2h)

`src/__tests__/network-safety.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { checkHttpUrlSafety, checkPostgresConnectionStringSafety } from "../lib/network-safety.js";

describe("checkHttpUrlSafety", () => {
  it("allows a public https URL", () => {
    expect(checkHttpUrlSafety("https://api.example.com/webhook").safe).toBe(true);
  });

  it("rejects disallowed schemes", () => {
    expect(checkHttpUrlSafety("file:///etc/passwd").safe).toBe(false);
    expect(checkHttpUrlSafety("ftp://internal-host/").safe).toBe(false);
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
      expect(checkHttpUrlSafety(url).safe, `expected ${url} to be rejected`).toBe(false);
    }
  });

  it("rejects the cloud metadata IP", () => {
    expect(checkHttpUrlSafety("http://169.254.169.254/latest/meta-data/").safe).toBe(false);
  });

  it("rejects RFC1918 private ranges", () => {
    expect(checkHttpUrlSafety("http://10.0.0.5/").safe).toBe(false);
    expect(checkHttpUrlSafety("http://192.168.1.1/").safe).toBe(false);
    expect(checkHttpUrlSafety("http://172.16.0.1/").safe).toBe(false);
  });

  it("rejects the literal 'localhost' hostname", () => {
    expect(checkHttpUrlSafety("http://localhost/").safe).toBe(false);
  });

  it("passes real hostnames through Layer 1 (Layer 2 handles DNS-time risk)", () => {
    expect(checkHttpUrlSafety("https://internal-sounding-name.example.com/").safe).toBe(true);
  });
});

describe("checkPostgresConnectionStringSafety", () => {
  it("allows a well-formed external connection string", () => {
    expect(checkPostgresConnectionStringSafety("postgresql://user:pass@db.example.com:5432/mydb").safe).toBe(true);
  });

  it("rejects a connection string pointed at loopback", () => {
    expect(checkPostgresConnectionStringSafety("postgresql://user:pass@127.0.0.1:5432/mydb").safe).toBe(false);
  });

  it("rejects non-postgres schemes", () => {
    expect(checkPostgresConnectionStringSafety("mysql://user:pass@db.example.com/mydb").safe).toBe(false);
  });

  it("rejects multi-host connection strings", () => {
    expect(checkPostgresConnectionStringSafety("postgresql://user@host1:5432,host2:5432/db").safe).toBe(false);
  });
});
```

`src/__tests__/schema-safety.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { checkSchemaComplexity, scanForUnsafePatterns } from "../lib/schema-safety.js";

describe("checkSchemaComplexity", () => {
  it("accepts a realistic tool input schema", () => {
    expect(
      checkSchemaComplexity({
        type: "object",
        properties: { query: { type: "string" }, limit: { type: "number" } },
        required: ["query"],
      }).safe
    ).toBe(true);
  });

  it("rejects an oversized schema", () => {
    const huge = { type: "object", properties: {} as Record<string, unknown> };
    for (let i = 0; i < 2000; i++) huge.properties[`field_${i}`] = { type: "string", description: "x".repeat(50) };
    expect(checkSchemaComplexity(huge).safe).toBe(false);
  });

  it("rejects pathologically deep nesting", () => {
    let deep: any = { type: "string" };
    for (let i = 0; i < 20; i++) deep = { type: "object", properties: { nested: deep } };
    expect(checkSchemaComplexity(deep).safe).toBe(false);
  });
});

describe("scanForUnsafePatterns", () => {
  it("accepts schemas with no patterns", () => {
    expect(scanForUnsafePatterns({ type: "object", properties: { name: { type: "string" } } }).safe).toBe(true);
  });

  it("accepts realistic, safe patterns", () => {
    const schema = {
      type: "object",
      properties: {
        email: { type: "string", pattern: "^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$" },
        code: { type: "string", pattern: "^[A-Z]{3}-[0-9]{4}$" },
      },
    };
    expect(scanForUnsafePatterns(schema).safe).toBe(true);
  });

  it("rejects known catastrophic-backtracking patterns", () => {
    expect(scanForUnsafePatterns({ type: "string", pattern: "^(a+)+$" }).safe).toBe(false);
    expect(scanForUnsafePatterns({ type: "string", pattern: "^(a*)*$" }).safe).toBe(false);
  });

  it("catches unsafe patterns nested inside patternProperties keys", () => {
    expect(
      scanForUnsafePatterns({
        type: "object",
        patternProperties: { "^(a+)+$": { type: "string" } },
      }).safe
    ).toBe(false);
  });

  it("rejects a syntactically invalid regex with a distinct message", () => {
    const result = scanForUnsafePatterns({ type: "string", pattern: "^(unclosed[" });
    expect(result.safe).toBe(false);
    expect(result.errors?.[0]).toMatch(/not a syntactically valid regular expression/);
  });

  it("rejects an oversized pattern", () => {
    const result = scanForUnsafePatterns({ type: "string", pattern: "a".repeat(500) });
    expect(result.safe).toBe(false);
  });
});
```

`src/__tests__/handler-config.schema.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { handlerConfigSchema } from "../lib/handler-config.schema.js";

describe("handlerConfigSchema", () => {
  it("accepts a valid http config", () => {
    const result = handlerConfigSchema.safeParse({
      handlerType: "http",
      url: "https://api.example.com/webhook",
      method: "POST",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a postgres-shaped config declared as http (strict mode)", () => {
    const result = handlerConfigSchema.safeParse({
      handlerType: "http",
      url: "https://api.example.com/webhook",
      method: "POST",
      connectionString: "postgresql://...", // stray field from the other variant
    });
    expect(result.success).toBe(false);
  });

  it("rejects a URL targeting a private/internal address", () => {
    const result = handlerConfigSchema.safeParse({
      handlerType: "http",
      url: "http://169.254.169.254/latest/meta-data/",
      method: "GET",
    });
    expect(result.success).toBe(false);
  });

  it("rejects headers attempting to override Host", () => {
    const result = handlerConfigSchema.safeParse({
      handlerType: "http",
      url: "https://api.example.com/webhook",
      method: "POST",
      headers: { Host: "evil.internal" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects headers containing CRLF", () => {
    const result = handlerConfigSchema.safeParse({
      handlerType: "http",
      url: "https://api.example.com/webhook",
      method: "POST",
      headers: { "X-Custom": "value\r\nX-Injected: true" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a postgres connection string targeting loopback", () => {
    const result = handlerConfigSchema.safeParse({
      handlerType: "postgres",
      connectionString: "postgresql://user:pass@127.0.0.1:5432/prod",
      query: "SELECT 1",
    });
    expect(result.success).toBe(false);
  });
});
```

### ✅ Day 4 Checkpoint

- [ ] `tools` table migrated cleanly
- [ ] `tool.repository.ts`'s `setActiveStatus` targets `client.tool`, confirmed by reading the file, not just by memory of having fixed it
- [ ] All `network-safety.test.ts` cases pass, including every obfuscation variant
- [ ] All `schema-safety.test.ts` cases pass, including the false-positive check on realistic patterns
- [ ] All `handler-config.schema.test.ts` cases pass
- [ ] `npx tsc --noEmit` — zero errors
- [ ] `npm test` — full suite green

---

# Day 5 — Tool Service & Routes

**Hours target:** 5h (unchanged) — the deltas below are small in code volume but close a real gap, so don't skip reading the rationale even though the diff is short.

### The Merge-Order + Single-Source-of-Truth Fix

The original roadmap's service-layer example merged config like this:

```typescript
// ❌ Spread order lets a conflicting inner handlerType silently win
const parsedConfig = handlerConfigSchema.safeParse({
  handlerType: input.handlerType,
  ...(input.handlerConfig as object),
});
// ...
handlerType: input.handlerType, // stored value never confirmed against what was actually validated
```

If `input.handlerConfig` itself contains a `handlerType` key that disagrees with the outer field, the spread silently overrides it — the object gets validated under one `handlerType`, but the **plaintext DB column** ends up storing the outer field's original value regardless. Result: the plaintext `handlerType` column can end up disagreeing with what's actually inside the encrypted blob (e.g., column says `web_fetch`, ciphertext decrypts to a `postgres` config with a live connection string). Week 4's executor dispatches on the plaintext column — this becomes exactly the kind of confusing runtime mismatch the encrypt-before-CRUD ordering (Key Decision #4) was designed to prevent.

**Fix — two changes working together:**
1. Reverse the spread order so the authoritative outer field always wins the merge.
2. Combined with `.strict()` (already added in Day 4), any genuine shape conflict — not just a duplicate `handlerType` key — now fails validation outright instead of being silently stripped.
3. Persist `parsedConfig.data.handlerType` (the validated value), never `input.handlerType` a second time — single source of truth *after* validation, not before.

### `src/services/tool.service.ts` (complete, revised)

```typescript
import { toolRepository } from "../repositories/tool.repository.js";
import { handlerConfigSchema } from "../lib/handler-config.schema.js";
import { validateJsonSchema } from "../lib/schema-validator.js";
import { encryptConfig, decryptConfig } from "../lib/encryption.js";

/**
 * Tools are deactivate-only from this layer down — no hard-delete
 * path exists. See Week 2 Key Decision #5: hard-deleting a tool would
 * either cascade-destroy audit history in tool_executions /
 * audit_events (Week 5), or get blocked by a foreign key and fail
 * confusingly the first time a tool actually has executions.
 */
export const toolService = {
  async createTool(
    tenantId: string,
    input: {
      name: string;
      description?: string;
      category?: string;
      handlerType: string;
      handlerConfig: unknown;
      inputSchema: unknown;
      outputSchema?: unknown;
    }
  ) {
    // Outer field wins the merge — see "Merge-Order Fix" above. This,
    // combined with .strict() on every handler variant, means any
    // real shape conflict between the two fields fails validation
    // cleanly instead of one silently overriding the other.
    const parsedConfig = handlerConfigSchema.safeParse({
      ...(input.handlerConfig as object),
      handlerType: input.handlerType,
    });
    if (!parsedConfig.success) {
      throw new ValidationError("INVALID_HANDLER_CONFIG", parsedConfig.error.flatten());
    }

    const schemaCheck = validateJsonSchema(input.inputSchema);
    if (!schemaCheck.valid) {
      const code =
        schemaCheck.failedGate === "complexity"
          ? "SCHEMA_TOO_COMPLEX"
          : schemaCheck.failedGate === "pattern_safety"
            ? "UNSAFE_SCHEMA_PATTERN"
            : "INVALID_INPUT_SCHEMA";
      throw new ValidationError(code, schemaCheck.errors);
    }

    const ciphertext = encryptConfig(JSON.stringify(parsedConfig.data), tenantId);

    try {
      const tool = await toolRepository.create({
        tenantId,
        name: input.name,
        description: input.description,
        category: input.category,
        // Derived from the VALIDATED object, not the raw input a
        // second time — this is guaranteed to match what's actually
        // inside the ciphertext, by construction.
        handlerType: parsedConfig.data.handlerType,
        handlerConfig: ciphertext,
        inputSchema: input.inputSchema as any,
        outputSchema: input.outputSchema as any,
      });
      return toPublicTool(tool);
    } catch (err: any) {
      if (err.code === "P2002") {
        throw new Error("TOOL_NAME_TAKEN");
      }
      throw err;
    }
  },

  async listTools(tenantId: string) {
    const tools = await toolRepository.list(tenantId);
    return tools.map(toPublicTool);
  },

  async getTool(id: string, tenantId: string) {
    const tool = await toolRepository.findById(id, tenantId);
    return tool ? toPublicTool(tool) : null;
  },

  /**
   * Returns the DECRYPTED handler_config. Deliberately a separate
   * method from getTool() — decrypted connection strings and API keys
   * should only ever be materialized when something is about to USE
   * them (Week 4's executor), never as a side effect of a routine
   * listing/detail call.
   */
  async getDecryptedConfig(id: string, tenantId: string) {
    const tool = await toolRepository.findById(id, tenantId);
    if (!tool) return null;
    const plaintext = decryptConfig(tool.handlerConfig, tenantId);
    return JSON.parse(plaintext);
  },

  async updateTool(
    id: string,
    tenantId: string,
    input: { name?: string; description?: string; category?: string }
  ) {
    // Deliberately not accepting handlerConfig/handlerType here — see
    // the repository layer note on Day 4: both are immutable after
    // creation. Change the execution model → deactivate, create new.
    const { count } = await toolRepository.updateProfile(id, tenantId, input);
    if (count === 0) return null;
    return this.getTool(id, tenantId);
  },

  async deactivateTool(id: string, tenantId: string) {
    const { count } = await toolRepository.setActiveStatus(id, tenantId, false);
    return count > 0;
  },
};

export class ValidationError extends Error {
  constructor(
    public code:
      | "INVALID_HANDLER_CONFIG"
      | "INVALID_INPUT_SCHEMA"
      | "SCHEMA_TOO_COMPLEX"
      | "UNSAFE_SCHEMA_PATTERN",
    public details: unknown
  ) {
    super(code);
  }
}
// The specific reason for an INVALID_HANDLER_CONFIG failure — bad
// shape vs. blocked network target vs. forbidden header — is
// preserved in `.details` (Zod's flattened error), even though the
// top-level code stays generic. The three input_schema codes are
// distinguished at the top level because schema-validator.ts's three
// gates naturally separate them.

// Never let handlerConfig (ciphertext OR plaintext) leave via the
// default tool shape.
function toPublicTool(tool: {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  category: string | null;
  handlerType: string;
  inputSchema: unknown;
  outputSchema: unknown;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}) {
  const {
    id, tenantId, name, description, category,
    handlerType, inputSchema, outputSchema, isActive, createdAt, updatedAt,
  } = tool;
  return { id, tenantId, name, description, category, handlerType, inputSchema, outputSchema, isActive, createdAt, updatedAt };
}
```

Note this now calls `toolRepository.setActiveStatus` and `toolRepository.updateProfile` — matching the exact method names in your uploaded `tool.repository.ts` (once the Day 4 fix is applied), rather than the original roadmap's `updateById`/naming. If your repository still uses different method names, reconcile the names here, not the other way around — your repository file is the one you've already built and tested.

### `src/routes/tools.ts` (unchanged in shape from the original plan — reproduced here for completeness)

```typescript
import type { FastifyInstance } from "fastify";
import { toolService, ValidationError } from "../services/tool.service.js";

export async function toolRoutes(app: FastifyInstance) {
  app.post(
    "/",
    {
      schema: {
        body: {
          type: "object",
          required: ["name", "handlerType", "handlerConfig", "inputSchema"],
          properties: {
            name: { type: "string", minLength: 2, maxLength: 100 },
            description: { type: "string", maxLength: 500 },
            category: { type: "string", maxLength: 50 },
            handlerType: { type: "string", enum: ["http", "postgres", "web_fetch"] },
            handlerConfig: { type: "object" },
            inputSchema: { type: "object" },
            outputSchema: { type: "object" },
          },
        },
      },
    },
    async (request, reply) => {
      const { tenantId } = request.tenantContext;
      try {
        const tool = await toolService.createTool(tenantId, request.body as any);
        return reply.status(201).send(tool);
      } catch (err) {
        if (err instanceof ValidationError) {
          return reply.badRequest(JSON.stringify({ code: err.code, details: err.details }));
        }
        if (err instanceof Error && err.message === "TOOL_NAME_TAKEN") {
          return reply.conflict("A tool with this name already exists in this tenant");
        }
        throw err;
      }
    }
  );

  app.get("/", async (request) => {
    const { tenantId } = request.tenantContext;
    return toolService.listTools(tenantId);
  });

  app.get("/:id", async (request, reply) => {
    const { tenantId } = request.tenantContext;
    const { id } = request.params as { id: string };
    const tool = await toolService.getTool(id, tenantId);
    if (!tool) return reply.notFound();
    return tool;
  });

  app.patch("/:id", async (request, reply) => {
    const { tenantId } = request.tenantContext;
    const { id } = request.params as { id: string };
    const updated = await toolService.updateTool(id, tenantId, request.body as any);
    if (!updated) return reply.notFound();
    return updated;
  });

  app.delete("/:id", async (request, reply) => {
    const { tenantId } = request.tenantContext;
    const { id } = request.params as { id: string };
    const deactivated = await toolService.deactivateTool(id, tenantId);
    if (!deactivated) return reply.notFound();
    return reply.status(204).send();
  });
}
```

Wire into `app.ts` exactly as originally planned:

```typescript
import { toolRoutes } from "./routes/tools.js";
// ...inside the same protected scope as agentRoutes:
await scope.register(toolRoutes, { prefix: "/api/tools" });
```

### Manual Verification — now including negative cases (30 min)

```bash
# Happy path
curl -X POST http://localhost:3000/api/tools \
  -H "Authorization: Bearer <access_token>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "public-status-page",
    "handlerType": "web_fetch",
    "handlerConfig": { "handlerType": "web_fetch", "url": "https://status.example.com" },
    "inputSchema": { "type": "object", "properties": {} }
  }'

# Should be REJECTED — SSRF target
curl -X POST http://localhost:3000/api/tools \
  -H "Authorization: Bearer <access_token>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "ssrf-attempt",
    "handlerType": "web_fetch",
    "handlerConfig": { "handlerType": "web_fetch", "url": "http://169.254.169.254/latest/meta-data/" },
    "inputSchema": { "type": "object", "properties": {} }
  }'

# Should be REJECTED — unsafe regex pattern
curl -X POST http://localhost:3000/api/tools \
  -H "Authorization: Bearer <access_token>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "redos-attempt",
    "handlerType": "web_fetch",
    "handlerConfig": { "handlerType": "web_fetch", "url": "https://status.example.com" },
    "inputSchema": { "type": "object", "properties": { "x": { "type": "string", "pattern": "^(a+)+$" } } }
  }'

# Inspect the raw DB row for the happy-path tool and confirm
# handler_config is unreadable ciphertext, not JSON.
```

### ✅ Day 5 Checkpoint

- [ ] Full tool lifecycle works via curl: create → get → patch → delete (deactivate)
- [ ] Both negative curl cases above return `400` with the correct `ValidationError` code
- [ ] Raw DB row's `handler_config` column is unreadable ciphertext, confirmed by direct inspection
- [ ] `npm test` passes

---

# Day 6 — Integration Testing, Proof Checkpoint & Code Review (extended gate)

**Hours target:** 5–6h (up slightly from 5h to cover the new test surface).

### The Two Original Proof-Checkpoint Tests — Unchanged

These still exist exactly as originally planned and are still mandatory:
- Encryption ciphertext-not-plaintext + roundtrip
- Raw API key shown exactly once

(See original `roadmap_w2.md` Day 6 Step 2 for the full text — nothing about them changes here.)

### New Tests Added to the Same Blocking Gate

```typescript
describe("Repository Bug Regression — setActiveStatus targets the right table", () => {
  it("setActiveStatus deactivates the TOOL, not any other entity", async () => {
    const tenant = await createTestTenant();
    const tool = await createTestTool(tenant.id);

    const { count } = await toolRepository.setActiveStatus(tool.id, tenant.id, false);
    expect(count).toBe(1);

    const updated = await prisma.tool.findUniqueOrThrow({ where: { id: tool.id } });
    expect(updated.isActive).toBe(false);

    await cleanupTenant(tenant.id);
  });
});

describe("handlerType Single-Source-of-Truth", () => {
  it("cannot cause the stored handlerType column to disagree with the ciphertext contents", async () => {
    const tenant = await createTestTenant();

    // A crafted request where handlerConfig's shape doesn't match the
    // declared handlerType at all — strict mode must reject this
    // outright, not silently coerce it.
    await expect(
      toolService.createTool(tenant.id, {
        name: "confused-tool",
        handlerType: "web_fetch",
        handlerConfig: {
          handlerType: "postgres", // disagrees with outer field
          connectionString: "postgresql://user:pass@db.example.com/prod",
          query: "SELECT 1",
        },
        inputSchema: { type: "object", properties: {} },
      })
    ).rejects.toThrow();

    await cleanupTenant(tenant.id);
  });
});

describe("SSRF Pre-Filter — Integration", () => {
  it("rejects tool creation with a handler_config targeting internal/private infrastructure", async () => {
    const tenant = await createTestTenant();
    await expect(
      toolService.createTool(tenant.id, {
        name: "internal-target",
        handlerType: "http",
        handlerConfig: { handlerType: "http", url: "http://169.254.169.254/", method: "GET" },
        inputSchema: { type: "object", properties: {} },
      })
    ).rejects.toThrow();
    await cleanupTenant(tenant.id);
  });
});

describe("ReDoS Pattern Gate — Integration", () => {
  it("rejects tool creation with an unsafe input_schema pattern", async () => {
    const tenant = await createTestTenant();
    await expect(
      toolService.createTool(tenant.id, {
        name: "redos-tool",
        handlerType: "web_fetch",
        handlerConfig: { handlerType: "web_fetch", url: "https://example.com" },
        inputSchema: { type: "object", properties: { x: { type: "string", pattern: "^(a+)+$" } } },
      })
    ).rejects.toThrow();
    await cleanupTenant(tenant.id);
  });

  it("does NOT reject legitimate, realistic input schemas (false-positive check)", async () => {
    const tenant = await createTestTenant();
    const tool = await toolService.createTool(tenant.id, {
      name: "email-validator-tool",
      handlerType: "web_fetch",
      handlerConfig: { handlerType: "web_fetch", url: "https://example.com" },
      inputSchema: {
        type: "object",
        properties: { email: { type: "string", pattern: "^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$" } },
      },
    });
    expect(tool.id).toBeDefined();
    await cleanupTenant(tenant.id);
  });
});
```

Plus the existing (unchanged) cross-tenant isolation tests for agents and tools from the original Day 6 plan.

### Extended Code Review Checklist

All original Day 6 checklist items, plus:

- [ ] `network-safety.ts` and `schema-safety.ts` are pure functions with no DB/I/O, independently unit-tested
- [ ] `setActiveStatus` in `tool.repository.ts` calls `client.tool`, confirmed by reading the current file
- [ ] Every handler-config Zod schema (`http`, `postgres`, `web_fetch`) uses `.strict()`
- [ ] `tool.service.ts`'s merge places `input.handlerType` **after** the spread (outer field wins)
- [ ] The persisted `handlerType` column comes from `parsedConfig.data.handlerType`, never `input.handlerType` directly
- [ ] `validateJsonSchema(undefined)` and other garbage input produce a clean `{valid:false}`, not a thrown exception
- [ ] `npx tsc --noEmit` — zero errors
- [ ] `npm test` — full suite green

### ✅ Day 6 Checkpoint (Week 2 Gate)

**All of these must pass before proceeding to Week 3:**
- [ ] Encryption proof checkpoint test passes
- [ ] API key proof checkpoint test passes
- [ ] `setActiveStatus` regression test passes
- [ ] `handlerType` single-source-of-truth test passes
- [ ] SSRF pre-filter integration test passes
- [ ] ReDoS pattern gate integration test passes (both the rejection case and the false-positive check)
- [ ] Cross-tenant isolation proven for both agents and tools
- [ ] Extended code review checklist fully checked off
- [ ] `npx tsc --noEmit` — zero errors

---

## `PROGRESS.md` Addition (append, don't overwrite)

```markdown
## Week 2 — Complete (Security-Hardened Revision)

### What changed from the original Week 2 plan
- Fixed a repository bug where `tool.repository.ts`'s `setActiveStatus`
  targeted `client.agent` instead of `client.tool` (copy-paste artifact) —
  would have silently no-op'd every tool deactivation
- Added a two-layer SSRF defense for handler_config URLs/connection
  strings: Layer 1 (this week) is a string-level pre-filter using
  ipaddr.js range classification, verified against decimal/hex/octal
  IP obfuscation and IPv4-mapped IPv6 forms. Layer 2 (DNS-resolution-
  time, checking the RESOLVED IP on every call) is a hard blocking
  prerequisite for Week 4 (M4) before any HTTP/Postgres/WebFetch
  handler goes live — Layer 1 alone must never be treated as the real
  boundary, since a hostname's resolution can change between check
  and use (DNS rebinding)
- Added a schema-safety gate for tenant-submitted input_schema:
  complexity ceiling (size + nesting depth) and a regex pattern safety
  scan (safe-regex) against catastrophic backtracking. This matters
  more than a typical validation gate: Week 6 will ajv.compile() and
  RUN every stored input_schema on every tools/call, and a hung
  synchronous regex match cannot be cancelled via AbortController the
  way Week 4's async I/O handlers can — this gate is the only defense
  against that failure mode anywhere in the system
- Added `.strict()` to every handler_config Zod variant and fixed a
  merge-order bug in tool.service.ts where a conflicting handlerType
  key inside handlerConfig could silently disagree with the persisted
  plaintext column vs. what's actually inside the encrypted blob

### Known, accepted limitations (not gaps — documented tradeoffs)
- SSRF Layer 1 cannot validate hostnames that resolve to a private IP
  (only literal IPs are checked at this stage) — by design; Layer 2 is
  the real boundary and is scheduled for Week 4
- safe-regex is a heuristic (star-height analysis), not a formal
  proof — confirmed via testing that it catches nested-quantifier
  patterns reliably with zero false positives on realistic schemas,
  but does not flag every theoretically pathological pattern (e.g.
  ambiguous alternation like `(a|a)+`)
- Postgres connection string validation supports single-host URI form
  only; multi-host failover strings are rejected as unsupported rather
  than partially validated

### Proof checkpoint
- handler_config stored as ciphertext, confirmed via raw DB query;
  roundtrip via service passes
- Raw agent API key shown exactly once; absent from every subsequent
  response and every DB column
- Cross-tenant isolation proven for both agents and tools
- setActiveStatus regression test passes (targets the correct table)
- SSRF pre-filter and ReDoS pattern gate both proven via integration
  tests, including a false-positive check against realistic patterns

### Deferred (planned for Week 3+)
- agent_tool_permissions composite unique constraint ([agentId, toolId])
- Layer 2 SSRF defense (DNS-resolution-time IP validation) — hard
  blocking prerequisite for Week 4, not optional hardening
- Role-based restriction on agent/tool creation — optional, not
  required for the MVP gate
```

---

## Hours Summary (Revised)

| Day | Focus | Original | Revised |
|---|---|---|---|
| Day 4 | Tool schema + handler_config/input_schema shape **and safety** validation | 5h | **7–8h** |
| Day 5 | Tool service + routes (+ merge-order fix) | 5h | 5h |
| Day 6 | Integration tests + extended proof checkpoint + review | 5h | 5–6h |

If you're doing 3–4h/day rather than the target, stretch this across more calendar days rather than compressing Day 4 — the SSRF and ReDoS gates are the load-bearing content of this revision, not padding.

---

*Days 1–3 of `roadmap_w2.md` are unaffected and remain your source of truth for those days. Week 3 roadmap begins only after the Day 6 gate above passes.*