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

## Day 4 — Tool Schema, `handler_config` Validation & `input_schema` Validation

**Hours target:** 5h

### Concept Primer (~20 min)

**Zod discriminated unions.** A discriminated union picks which sub-schema to validate against based on the value of one shared field (here, `handlerType`). This is exactly the shape you need: an `http` config, a `postgres` config, and a `web_fetch` config have different required fields, and you want a `400` the moment someone submits a `postgres`-shaped body while claiming `handlerType: "http"`. Docs: https://zod.dev (see "Discriminated Unions").

**AJV `strict` mode — a deliberate choice, not a default.** Ajv v8 defaults to `strict: true`, which is right when *you* are authoring schemas and want Ajv to catch your own mistakes. Here, the validator's only job is confirming a *tenant-submitted* schema is syntactically valid JSON Schema — not enforcing your own schema-authoring conventions on tenants. This roadmap uses `strict: false` deliberately for that reason; tighten it later if you decide you want to reject permissive-but-valid tenant schemas (e.g., ones missing an explicit `type`). Docs: https://ajv.js.org (see "Strict mode").

### Build Block

**Step 1 — Prisma schema addition (15 min)**

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

Add `tools Tool[]` to your `Tenant` model's relation block, same as you did for `agents` on Day 1.

```bash
npx prisma migrate dev --name add_tools_table
npx prisma generate
```

**Step 2 — `handler_config` shape validation (`src/lib/handler-config.schema.ts`) (45 min)**

```typescript
import { z } from "zod";

/**
 * Validates the SHAPE of handler_config against the declared
 * handlerType, before it is ever encrypted or stored. This is a
 * distinct concern from inputSchema validation below: inputSchema
 * describes what an AGENT is allowed to pass as tool arguments at
 * call time; handlerConfig describes how the PLATFORM executes the
 * tool. A malformed handlerConfig getting into the DB would surface
 * as a confusing runtime failure in Week 4's executor — far better
 * to reject it here with a clear 400.
 */

export const httpHandlerConfigSchema = z.object({
  handlerType: z.literal("http"),
  url: z.string().url(),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  headers: z.record(z.string()).optional(),
  bodyTemplate: z.string().optional(),
});

export const postgresHandlerConfigSchema = z.object({
  handlerType: z.literal("postgres"),
  connectionString: z.string().min(1),
  query: z.string().min(1),
});

export const webFetchHandlerConfigSchema = z.object({
  handlerType: z.literal("web_fetch"),
  url: z.string().url(),
});

export const handlerConfigSchema = z.discriminatedUnion("handlerType", [
  httpHandlerConfigSchema,
  postgresHandlerConfigSchema,
  webFetchHandlerConfigSchema,
]);

export type HandlerConfig = z.infer<typeof handlerConfigSchema>;
```

**Step 3 — `input_schema` well-formedness validation (`src/lib/schema-validator.ts`) (20 min)**

```typescript
import Ajv from "ajv";

/**
 * Validates that a TENANT-SUBMITTED input_schema is itself a
 * well-formed JSON Schema. This does NOT validate actual tool-call
 * arguments against the schema (that happens in Week 6, per-call,
 * via ajv.compile()) — it only guards against storing a broken
 * schema that would silently corrupt every agent's tools/list
 * response.
 *
 * strict:false is deliberate here — see the Day 4 concept primer.
 */
const ajv = new Ajv({ allErrors: true, strict: false });

export function validateJsonSchema(schema: unknown): {
  valid: boolean;
  errors?: string[];
} {
  const valid = ajv.validateSchema(schema);
  if (!valid) {
    return {
      valid: false,
      errors: (ajv.errors ?? []).map((e) => `${e.instancePath || "(root)"} ${e.message}`),
    };
  }
  return { valid: true };
}
```

**Step 4 — Tool repository (`src/repositories/tool.repository.ts`) (30 min)**

```typescript
import { prisma } from "../lib/prisma.js";
import type { DbClient } from "../types/db-client.type.js";
import type { Prisma } from "@prisma/client";

export const toolRepository = {
  create: (
    data: {
      tenantId: string;
      name: string;
      description?: string;
      category?: string;
      handlerType: string;
      handlerConfig: string; // already-encrypted ciphertext
      inputSchema: Prisma.InputJsonValue;
      outputSchema?: Prisma.InputJsonValue;
    },
    client: DbClient = prisma
  ) => client.tool.create({ data }),

  findById: (id: string, tenantId: string, client: DbClient = prisma) =>
    client.tool.findFirst({ where: { id, tenantId } }),

  list: (tenantId: string, client: DbClient = prisma) =>
    client.tool.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" } }),

  // Deliberately no handlerType or handlerConfig in this signature —
  // both are immutable after creation. If a tool's execution model
  // needs to change, deactivate it and create a new one. This keeps
  // "validate against the tool's handlerType" unambiguous and
  // matches how Week 4's executor will key its dispatch logic.
  updateById: (
    id: string,
    tenantId: string,
    data: Partial<{ name: string; description: string; category: string; isActive: boolean }>,
    client: DbClient = prisma
  ) => client.tool.updateMany({ where: { id, tenantId }, data }),

  // Note: there is no delete() method here at all — see Key
  // Decision #5. Deactivation is the only removal path, enforced by
  // this method simply not existing.
};
```

**Step 5 — Validation tests (30 min)**

```typescript
describe("handlerConfigSchema", () => {
  it("accepts a valid http config", () => {
    const result = handlerConfigSchema.safeParse({
      handlerType: "http",
      url: "https://api.example.com/webhook",
      method: "POST",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a postgres-shaped config declared as http", () => {
    const result = handlerConfigSchema.safeParse({
      handlerType: "http",
      connectionString: "postgresql://...",
      query: "SELECT 1",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid URL", () => {
    const result = handlerConfigSchema.safeParse({ handlerType: "web_fetch", url: "not-a-url" });
    expect(result.success).toBe(false);
  });
});

describe("validateJsonSchema", () => {
  it("accepts a well-formed JSON Schema", () => {
    const result = validateJsonSchema({
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    });
    expect(result.valid).toBe(true);
  });

  it("rejects a schema with an invalid type keyword", () => {
    const result = validateJsonSchema({ type: "not-a-real-type" });
    expect(result.valid).toBe(false);
  });
});
```

### ✅ Day 4 Checkpoint

- [ ] `tools` table migrated cleanly
- [ ] Discriminated union rejects mismatched handlerType/config pairs
- [ ] AJV wrapper accepts valid schemas and rejects malformed ones
- [ ] `npx tsc --noEmit` — zero errors

---

## Day 5 — Tool Service & Routes

**Hours target:** 5h

### Build Block

**Step 1 — Tool service (`src/services/tool.service.ts`) (1.5h)**

```typescript
import { toolRepository } from "../repositories/tool.repository.js";
import { handlerConfigSchema } from "../lib/handler-config.schema.js";
import { validateJsonSchema } from "../lib/schema-validator.js";
import { encryptConfig, decryptConfig } from "../lib/encryption.js";

/**
 * Tools are deactivate-only from this layer down — no hard-delete
 * path exists. See Week 2 Key Decision #5: hard-deleting a tool
 * would either cascade-destroy audit history in tool_executions /
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
    // handlerType is submitted as its own field (and stored as its
    // own plaintext column per the PRD data model — knowing a tool
    // is "postgres-backed" isn't sensitive, the connection string
    // is). The discriminated union expects handlerType INSIDE the
    // object it validates, so merge here for validation purposes;
    // the merged object is also what gets encrypted, so the
    // decrypted config is self-describing later.
    const parsedConfig = handlerConfigSchema.safeParse({
      handlerType: input.handlerType,
      ...(input.handlerConfig as object),
    });
    if (!parsedConfig.success) {
      throw new ValidationError("INVALID_HANDLER_CONFIG", parsedConfig.error.flatten());
    }

    const schemaCheck = validateJsonSchema(input.inputSchema);
    if (!schemaCheck.valid) {
      throw new ValidationError("INVALID_INPUT_SCHEMA", schemaCheck.errors);
    }

    const ciphertext = encryptConfig(JSON.stringify(parsedConfig.data), tenantId);

    try {
      const tool = await toolRepository.create({
        tenantId,
        name: input.name,
        description: input.description,
        category: input.category,
        handlerType: input.handlerType,
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
   * method from getTool() — decrypted connection strings and API
   * keys should only ever be materialized when something is about
   * to USE them (Week 4's executor), never as a side effect of a
   * routine listing/detail call.
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
    // Deliberately not accepting handlerConfig/handlerType here for
    // MVP — see the repository layer note on Day 4.
    const { count } = await toolRepository.updateById(id, tenantId, input);
    if (count === 0) return null;
    return this.getTool(id, tenantId);
  },

  async deactivateTool(id: string, tenantId: string) {
    const { count } = await toolRepository.updateById(id, tenantId, { isActive: false });
    return count > 0;
  },
};

export class ValidationError extends Error {
  constructor(public code: string, public details: unknown) {
    super(code);
  }
}
// This introduces one small typed error alongside your existing
// string-message Error convention (throw new Error('CODE')). They
// coexist fine — simple sentinel strings for simple branching,
// this one richer class for structured 400 feedback. Reconcile with
// your global sanitizing error handler (the Day 6 Week-1 fix) if it
// doesn't already special-case this.

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

**Step 2 — Routes (`src/routes/tools.ts`) (1h)**

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
          // Adapt this to whatever shape your global sanitizing
          // error handler expects — this is the simplest form.
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

**Step 3 — Wire into `app.ts` (10 min)**

```typescript
import { toolRoutes } from "./routes/tools.js";

// ...inside the same protected scope as agentRoutes:
await scope.register(toolRoutes, { prefix: "/api/tools" });
```

**Step 4 — Manual verification (20 min)**

```bash
curl -X POST http://localhost:3000/api/tools \
  -H "Authorization: Bearer <access_token>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "public-status-page",
    "handlerType": "web_fetch",
    "handlerConfig": { "handlerType": "web_fetch", "url": "https://status.example.com" },
    "inputSchema": { "type": "object", "properties": {} }
  }'

# Then inspect the raw DB row directly (psql / TablePlus) and confirm
# handler_config is NOT readable JSON — it should look like base64
# noise separated by colons.
```

**Step 5 — Tests (1h)**

```typescript
describe("Tool CRUD", () => {
  it("creates a tool and stores handler_config as ciphertext (raw DB row is not plaintext)")
  it("rejects creation when handlerConfig doesn't match the declared handlerType (400)")
  it("rejects creation when inputSchema is not a valid JSON Schema (400)")
  it("returns 409 when creating a second tool with the same name in the same tenant")
  it("PATCH updates name/description/category but not handlerType or handlerConfig")
  it("DELETE deactivates (isActive=false) rather than removing the row")
  it("getDecryptedConfig round-trips the original handlerConfig via the service")
})
```

### ✅ Day 5 Checkpoint

- [ ] Full tool lifecycle works via curl: create → get → patch → delete (deactivate)
- [ ] Raw DB row's `handler_config` column is unreadable ciphertext, confirmed by direct inspection
- [ ] Mismatched handlerConfig/handlerType and malformed inputSchema both produce clean 400s
- [ ] `npm test` passes

---

## Day 6 — Integration Testing, Proof Checkpoint & Code Review

**Hours target:** 5h — same spirit as Week 1's Day 6: this is a testing/review day, not a new-feature day. If Days 1–5 are solid, this should feel confirmatory, not stressful.

### Build Block

**Step 1 — Extend the test tenant factory (30 min)**

Add to your existing `src/__tests__/helpers/test-tenant.factory.ts`:

```typescript
import { prisma } from "../../lib/prisma.js";
import { generateApiKey, hashApiKeySecret } from "../../lib/api-key.js";
import { encryptConfig } from "../../lib/encryption.js";

export async function createTestAgent(
  tenantId: string,
  createdBy: string,
  overrides: Partial<{ name: string; description: string }> = {}
) {
  const { keyId, rawSecret, fullKey } = generateApiKey();
  const apiKeyHash = await hashApiKeySecret(rawSecret);

  const agent = await prisma.agent.create({
    data: {
      tenantId,
      createdBy,
      name: overrides.name ?? `test-agent-${Date.now()}`,
      description: overrides.description,
      apiKeyId: keyId,
      apiKeyHash,
    },
  });

  return { agent, apiKey: fullKey }; // apiKey needed for gateway tests from Week 6 onward
}

export async function createTestTool(
  tenantId: string,
  overrides: Partial<{ name: string; handlerType: string; handlerConfig: object; inputSchema: object }> = {}
) {
  const handlerType = overrides.handlerType ?? "web_fetch";
  const handlerConfig = overrides.handlerConfig ?? { handlerType, url: "https://example.com" };

  const tool = await prisma.tool.create({
    data: {
      tenantId,
      name: overrides.name ?? `test-tool-${Date.now()}`,
      handlerType,
      handlerConfig: encryptConfig(JSON.stringify(handlerConfig), tenantId),
      inputSchema: overrides.inputSchema ?? { type: "object", properties: {} },
    },
  });

  return tool;
}
```

**A note on `cleanupTenant(tenantId)`:** because `Agent` and `Tool` both cascade from `Tenant` (`onDelete: Cascade`), if your existing `cleanupTenant` simply deletes the tenant row, agents and tools created during tests are cleaned up automatically — no changes needed there. If it instead does explicit per-table deletes in a specific order, add `tool` and `agent` deletes before the tenant delete.

**Step 2 — The two official Week 2 Proof Checkpoint tests (1h)**

These match `roadmap.md`'s stated Week 2 gate exactly.

```typescript
describe("Week 2 Proof Checkpoint — Encryption", () => {
  it("stores handler_config as ciphertext, not plaintext, and round-trips via the service", async () => {
    const tenant = await createTestTenant();
    const secretConnectionString = "postgresql://prod-user:s3cr3t@db.internal:5432/prod";

    const tool = await toolService.createTool(tenant.id, {
      name: "internal-db-query",
      handlerType: "postgres",
      handlerConfig: {
        handlerType: "postgres",
        connectionString: secretConnectionString,
        query: "SELECT 1",
      },
      inputSchema: { type: "object", properties: {} },
    });

    const rawRow = await prisma.tool.findUniqueOrThrow({ where: { id: tool.id } });
    expect(rawRow.handlerConfig).not.toContain(secretConnectionString);
    expect(rawRow.handlerConfig).not.toContain("s3cr3t");

    const decrypted = await toolService.getDecryptedConfig(tool.id, tenant.id);
    expect(decrypted.connectionString).toBe(secretConnectionString);

    await cleanupTenant(tenant.id);
  });
});

describe("Week 2 Proof Checkpoint — API Keys", () => {
  it("returns the raw API key exactly once; it is never retrievable again", async () => {
    const tenant = await createTestTenant();
    // adjust `tenant.ownerUserId` to whatever your existing factory
    // actually returns (e.g. tenant.owner.id) — any real userId works
    const created = await agentService.createAgent(tenant.id, tenant.ownerUserId, {
      name: "billing-agent",
    });

    expect(created.apiKey).toMatch(/^agk\./);

    const fetched = await agentService.getAgent(created.agent.id, tenant.id);
    expect(JSON.stringify(fetched)).not.toContain(created.apiKey);

    const rawRow = await prisma.agent.findUniqueOrThrow({ where: { id: created.agent.id } });
    expect(rawRow.apiKeyHash).not.toBe(created.apiKey);
    expect(rawRow.apiKeyHash.startsWith("$argon2")).toBe(true);

    await cleanupTenant(tenant.id);
  });
});
```

**Step 3 — Cross-tenant isolation for the two new entities (1h)**

```typescript
describe("Cross-Tenant Isolation — Agents & Tools", () => {
  it("Tenant A cannot read, update, or deactivate Tenant B's agent", async () => {
    const tenantA = await createTestTenant();
    const tenantB = await createTestTenant();
    const { agent } = await createTestAgent(tenantB.id, tenantB.ownerUserId);

    expect(await agentService.getAgent(agent.id, tenantA.id)).toBeNull();
    expect(await agentService.updateAgent(agent.id, tenantA.id, { name: "hijacked" })).toBeNull();
    expect(await agentService.deactivateAgent(agent.id, tenantA.id)).toBe(false);

    // Prove Tenant B is genuinely untouched
    const stillThere = await agentService.getAgent(agent.id, tenantB.id);
    expect(stillThere?.isActive).toBe(true);
    expect(stillThere?.name).not.toBe("hijacked");

    await cleanupTenant(tenantA.id);
    await cleanupTenant(tenantB.id);
  });

  it("Tenant A cannot read Tenant B's tool, even knowing its ID", async () => {
    const tenantA = await createTestTenant();
    const tenantB = await createTestTenant();
    const tool = await createTestTool(tenantB.id);

    expect(await toolService.getTool(tool.id, tenantA.id)).toBeNull();

    await cleanupTenant(tenantA.id);
    await cleanupTenant(tenantB.id);
  });
});
```

**Step 4 — Code review pass (45 min)**

Go through every file added this week and check:

- [ ] Every mutation method in `agent.repository.ts` and `tool.repository.ts` takes `tenantId` in its `where` clause — no exceptions, no repeat of the Week 1 `updateVerified`/`updateRefreshTokenHash` gap
- [ ] `agentRepository.findByKeyId` is the *only* repository method in either file that doesn't scope by tenantId, and it's clearly commented explaining why
- [ ] No route response includes `apiKeyHash`, `apiKeyId`, or handler_config in any form (ciphertext or plaintext)
- [ ] Every POST/PATCH route has JSON Schema validation on its request body
- [ ] `tool.repository.ts` has no `delete`/hard-remove method at all
- [ ] Confirm `requireActiveIdentity` is actually registered as a `preHandler` in `app.ts`'s protected scope (flagged as a gap between the README description and the `app.ts` snapshot at the start of Week 2 — resolve one way or the other before moving on)
- [ ] `npx tsc --noEmit` — zero errors
- [ ] `npm test` — full suite green

### ✅ Day 6 Checkpoint (Week 2 Gate)

**All of these must pass before proceeding to Week 3:**
- [ ] Encryption proof checkpoint test passes
- [ ] API key proof checkpoint test passes
- [ ] Cross-tenant isolation proven for both agents and tools
- [ ] Code review checklist above fully checked off
- [ ] `npx tsc --noEmit` — zero errors

---

## Day 7 — Buffer, Hardening & Week 3 Preview

**Hours target:** 3–4h (lighter day by design, same as Week 1)

### Block 1 — Catch-Up (as needed)

If any Day 1–6 checkpoint is incomplete, fix it now. The two proof-checkpoint tests and the cross-tenant isolation tests are the non-negotiable gate — don't carry this debt into Week 3, where `agent_tool_permissions` will reference both `agents` and `tools` directly.

### Block 2 — Code Hardening (45 min)

- [ ] Replace any `console.log` introduced this week with `app.log.info`/`app.log.error`
- [ ] Confirm `docker compose down && docker compose up -d && npm run dev` still starts cleanly with the two new migrations applied
- [ ] Confirm a missing `AGENTGATE_PLATFORM_ENCRYPTION_KEY` or `AGENTGATE_API_KEY_PEPPER` crashes the process immediately on boot (same fail-fast pattern as Week 1's other required env vars) — this is a five-minute test worth actually running, not just assuming

### Block 3 — Week 3 Preview (20 min, skim only)

Week 3 builds `agent_tool_permissions` + the Redis Lua rate limiter — both already scoped in `roadmap.md`. Skim, don't build:

- [ioredis README](https://github.com/redis/ioredis#readme) — "Quick Start" and "Lua Scripting" sections
- [Redis INCR pattern for rate limiting](https://redis.io/commands/incr/#pattern-rate-limiter)

Remember the forward-note from this week: add `@@unique([agentId, toolId])` to `agent_tool_permissions` when you define it — nothing about the design changes, it's a one-line addition while the model is fresh in your head.

### Block 4 — PROGRESS.md Addition

Append to your existing `PROGRESS.md` (don't overwrite — this is a suggested addition, not a replacement):

```markdown
## Week 2 — Complete

### What was built
- Agents table + full CRUD, tenant-scoped
- Two-part API key format (`agk.<keyId>.<secret>`) replacing a single
  opaque token — fixes an unscalable O(n) argon2-verify sweep the
  original HLD's single-token design would have required at gateway
  connection time (Week 6)
- API key hashing: argon2 + AGENTGATE_API_KEY_PEPPER, mirroring the
  password pepper pattern
- Tools table + full CRUD, tenant-scoped
- handler_config validated against a per-handlerType Zod
  discriminated union BEFORE encryption
- input_schema validated as well-formed JSON Schema via AJV
- AES-256-GCM encryption with per-tenant HKDF-derived subkeys
  (deviation from HLD: derives a subkey per tenant from one platform
  master key rather than using the master key directly — see
  roadmap_w2.md "Key Decisions" #2 for the honest tradeoff)
- Tools/Agents are deactivate-only; no hard-delete path exists at any
  layer, to protect audit FK integrity ahead of Week 5

### Proof checkpoint
- handler_config stored as ciphertext, confirmed via raw DB query;
  roundtrip via service passes
- Raw agent API key shown exactly once; absent from every subsequent
  response and every DB column
- Cross-tenant isolation proven for both agents and tools (read,
  update, deactivate all fail closed)

### Deferred (planned for Week 3+)
- agent_tool_permissions composite unique constraint
  ([agentId, toolId]) — add when the table lands in Week 3
- Role-based restriction on who within a tenant can create/rotate
  agents (currently any authenticated tenant member can) — optional
  hardening, not required for the MVP gate
- Rate limiting on the new agent/tool management endpoints — same
  Week 3 Redis infrastructure already tracked for auth endpoints
  covers this
```

### Nice-to-haves not required for the Week 2 gate

Keep this list short and don't build any of it this week — flagged only so it's not forgotten:

- Pagination on `GET /api/agents` / `GET /api/tools` — not needed at MVP per-tenant counts, cheap to add later
- Role-restriction on agent/tool creation (owner/admin only, not member) — not in the original PRD's MVP scope for management-action RBAC

---

## Week 2 Hours Summary

| Day | Focus | Target Hours |
|---|---|---|
| Day 1 | Agent schema + API key format redesign | 5–6h |
| Day 2 | Agent service, routes, rotation | 5h |
| Day 3 | AES-256-GCM encryption utility (critical day) | 5–6h |
| Day 4 | Tool schema + handler_config/input_schema validation | 5h |
| Day 5 | Tool service + routes | 5h |
| Day 6 | Integration tests + proof checkpoint + review | 5h |
| Day 7 | Buffer + hardening + Week 3 preview | 3–4h |
| **Total** | | **33–38h** |

Same flexibility note as Week 1: if you're doing 3–4h/day instead of 5–6h, stretch this to 10 days rather than compressing and skipping the Day 6 checkpoint. The checkpoint existing and passing is what makes Week 3's `agent_tool_permissions` — which references both tables you're building this week by foreign key — safe to build on.

---

*Week 3 roadmap (Permission Enforcement & Rate Limiting) begins only after the Day 6 gate above passes — same rule as Week 1.*