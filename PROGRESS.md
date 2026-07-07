# AgentGate — Progress Journal

**Project:** Multi-tenant MCP Gateway Platform
**Roadmap reference:** `roadmap.md` (8-week plan) / `roadmap_w1.md` (Week 1 daily breakdown)
**Current position:** Week 1 — Milestone 1 (Multi-Tenant Bedrock), Day 4 of 7 complete
**Stack:** Node.js 22, TypeScript (strict), Fastify, Prisma (`@prisma/adapter-pg`), PostgreSQL 16, Redis (AOF) + BullMQ + ioredis

---

## How to Read This File

This is a running engineering journal, not a changelog. Each week gets a section. Within a week, entries are grouped by **what was built**, **what broke and why**, **decisions made and why**, and **what's deferred**. The goal is to preserve the reasoning behind decisions — not just the outcome — since that's what turns this into a legitimate flagship project rather than a tutorial walkthrough.

---

## Week 1 — Multi-Tenant Bedrock (Milestone 1)

### Status: Days 1–4 complete. Day 5 (TenantContext hardening) substantially underway ahead of schedule.

### What Was Built (Days 1–4, per `roadmap_w1.md`)

**Day 1 — Foundation**
- Fastify + TypeScript strict-mode scaffold
- `zod`-based environment validation (`src/config/env.ts`) — process fails fast on missing/malformed `AGENTGATE_*` vars
- Structured logging via pino, with `pino-pretty` in development
- Vitest wired in, first passing tests

**Day 2 — Data Layer**
- PostgreSQL + Redis via Docker Compose
- `Tenant` / `User` Prisma models defined and migrated (see `schema.prisma`), including `deletedAt` soft-delete columns and explicit indexes on `tenantId` and `verificationToken`
- Prisma singleton pattern adopted, later upgraded to use `@prisma/adapter-pg` (driver adapter) rather than the default engine — this was a deliberate stack decision, not roadmap-default
- Repository layer scaffolded (`tenant.repository.ts`, `user.repository.ts`)

**Day 3 — Registration & Async Email**
- `POST /auth/register-tenant` with argon2 password hashing (tenant + owner user created transactionally)
- BullMQ `email` queue + console-log stub worker
- Email verification token flow (`GET /auth/verify-email`)

**Day 4 — JWT Auth**
- `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`
- `@fastify/jwt` registered; access token (15 min) + refresh token (7 day, stored as argon2 hash)
- Protected test route (`/api/ping`, later evolved toward `/api/me`) to prove the `authenticate` preHandler works

### Ahead-of-Schedule Work (Day 5 territory, pulled forward)

While implementing Day 4, the TenantContext plugin, `authenticate` hook, and `attachTenantContext` hook were already built out and wired into `app.ts` in a protected route scope — this is nominally Day 5 scope in `roadmap_w1.md`. Rather than treat this as scope creep, it was used as an opportunity to harden the middleware early:

- **Fail-closed JWT claim validation.** `attach-tenant-context.hook.ts` now explicitly checks for the presence of `tenantId`, `userId`, and `role` on the decoded JWT payload. A token that verifies cryptographically but is missing a required claim is rejected with `401` rather than allowed through with `undefined` fields silently propagating into downstream tenant-scoped queries. This closes a subtle isolation gap: a structurally malformed-but-validly-signed token could otherwise have caused a Prisma query like `WHERE tenantId = undefined` to behave unpredictably rather than fail loudly.
- **Refresh token lookup index.** Added a Prisma index on `refreshTokenHash` to keep `/auth/refresh` off a full table scan as the user table grows.

### Bugs Found and Fixed

These are worth keeping visible — they're the kind of detail that demonstrates real debugging, not just following a tutorial:

1. **Transaction atomicity bug in the repository layer.** Repository methods were accepting a `tx` (transaction client) parameter but silently falling back to the global `prisma` singleton instead of using it — meaning writes that were supposed to be atomic within a `$transaction` block were actually being issued against the ambient connection. Fixed by enforcing that every repository call within a service-owned transaction boundary explicitly threads the `tx` client through.
2. **Error-contract mismatch between service and route layers.** The service layer was throwing plain strings (e.g. `'SLUG_TAKEN'`) while route handlers were checking `err instanceof SomeErrorClass` or checking `.message` inconsistently — meaning some error paths fell through to a generic 500 instead of the intended 409/400. Standardized the contract so route handlers reliably map known service-thrown error strings to the correct HTTP status.
3. **Field name / copy-paste bugs** in the auth service surfaced during the transaction fix (e.g. `existingUser` renamed to `existingTenant` for accuracy — the check was against tenant slug uniqueness, not user existence).
4. **ioredis nominal typing break.** BullMQ ships its own nested copy of `ioredis`, which — combined with a top-level `ioredis` install — produced two physically distinct classes that TypeScript's structural/nominal typing treated as incompatible (`Redis` from one import path wasn't assignable to `Redis` from the other). Resolved via `"overrides": { "ioredis": "$ioredis" }` in `package.json`, forcing both to resolve to a single physical install. This is a dependency-graph class of bug, not a logic bug, and worth remembering for any future BullMQ + custom Redis client combination.

### Architectural Decisions Made (and Why)

**Repository Pattern with Explicit Unit-of-Work Injection**
Every repository function accepts `client: Prisma.TransactionClient | PrismaClient = prisma` as its last parameter. The **service layer owns transaction boundaries** — it opens the `$transaction`, then explicitly passes `tx` into every repository call made within that boundary. Repositories never open transactions themselves and never guess at scope.
- *Why this over an ambient-context approach (e.g. `AsyncLocalStorage`) right now:* explicit injection is more verbose but fails loudly — a missed `tx` argument is a visible bug (as encountered above), not a silent one. `AsyncLocalStorage` is intentionally deferred until at least the M5 audit infrastructure milestone, once transaction chains get deep enough that explicit threading becomes unwieldy. Documented as a forward-looking migration, not adopted prematurely.
- A shared `DbClient` type alias is planned to avoid repeating the `Prisma.TransactionClient | PrismaClient` union across every future repository (agents, tools, permissions, tool_executions, audit_events).

**Worker/Queue/Connection Layering**
Structured as three distinct files with distinct responsibilities:
- `src/lib/redis.ts` — singleton ioredis connection only
- `src/queues/email.queue.ts` — `Queue` instance only
- `src/workers/email.worker.ts` — a **factory function**, not a top-level `new Worker(...)` instantiation

Boot and shutdown orchestration lives in `server.ts`. The factory-function pattern for workers is deliberate: instantiating a `Worker` at module top-level means merely *importing* the module (e.g. in a test file) starts consuming jobs and opening Redis connections as a side effect. A factory function keeps instantiation explicit and under the control of whatever calls it — `server.ts` in production, and a test harness in isolation, without import-time side effects either way.

**`server.ts` vs `app.ts` Separation**
`app.ts` owns request-handling concerns (Fastify instance, plugins, routes). `server.ts` owns process-level concerns (starting the listener, worker lifecycle, graceful shutdown ordering on `SIGTERM`/`SIGINT`). This split keeps `app.ts` testable via `app.inject()` without dragging in worker/Redis lifecycle for every route test.

**TenantContext via Fastify Hooks + Decorators, not Express-style middleware**
`request.tenantContext` is declared via `decorateRequest` in a dedicated plugin (`tenant-context.plugin.ts`) registered before any routes, then populated by a `preHandler` hook (`attachTenantContext`) that runs after JWT verification (`authenticate`). This is the idiomatic Fastify pattern — hooks are lifecycle-aware and encapsulation-respecting, unlike bolting middleware on via `app.use()`.

### Design Debt — Explicitly Tracked, Not Forgotten

| Item | Current State | Planned Resolution |
|---|---|---|
| Refresh token rotation & expiry | Single `refreshTokenHash` per user, no expiry, no rotation, no reuse detection | Introduce a dedicated `refresh_tokens` table (`expiresAt`, `revoked`, `lastUsedAt`, per-device) with rotation on every `/auth/refresh` call and reuse detection to flag token theft. Targeted for Week 2+. |
| Multi-device sessions | New login invalidates all other sessions (single token per user) | Intentional MVP constraint. Will require the same `refresh_tokens` table migration above — not a separate effort. |
| Auth endpoint rate limiting | Not yet implemented | Add `@fastify/rate-limit` scoped specifically to `/auth/login` and `/auth/refresh` before any public exposure. |
| Argon2 pepper | Not implemented | Deferred as a post-Week-1 hardening item; will use the `secret` option via env config once the core flow is stable. |
| `AsyncLocalStorage` for transaction context | Not adopted; explicit `tx` injection used instead | Revisit at M5 (audit infrastructure) once call chains are deep enough to justify the tradeoff. |

### Immediate Next Actions

1. Run and commit the Prisma migration adding the `refreshTokenHash` index in dev and CI.
2. Finish Day 5 per `roadmap_w1.md`: rename `/api/ping` → `/api/me`, confirm `tenantContext` shape end-to-end, wire graceful shutdown ordering (`app.close()` → worker drain → Redis `quit()` → Prisma `$disconnect()`).
3. Day 6 gate (**do not proceed to Week 2 without this passing**): the tenant isolation proof test — Tenant A's JWT must not be able to read or influence Tenant B's data under any circumstance, including forged/tampered tokens and header-based override attempts.
4. Day 7: hardening pass (replace stray `console.log`, confirm `npx tsc --noEmit` is clean, verify `docker compose down && up -d && npm run dev` boots clean from a cold state) and write the Week 1 summary below.

---

## Week 1 Summary (fill in once Day 6 gate passes)

- [ ] Tenant isolation proof test passing
- [ ] Forged JWT rejected
- [ ] No plaintext password/token in any DB column or API response
- [ ] Zero TypeScript errors (`npx tsc --noEmit`)
- [ ] All Week 1 tests green

*(Do not check these off speculatively — this section is the actual gate for starting Week 2: Agent & Tool Registries + AES-256-GCM handler config encryption.)*