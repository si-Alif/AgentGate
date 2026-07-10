# AgentGate — Engineering Progress Journal

**Project:** Multi-tenant MCP Gateway Platform

This document is an engineering journal rather than a changelog. It records not only **what** was built, but also **why** architectural decisions were made, what failures occurred during implementation, what tradeoffs were accepted, and what technical debt remains.

The goal is to document the engineering process behind AgentGate as it evolves into a production-grade backend platform.

---

## Project Information

| Item | Value |
|------|------|
| **Roadmap** | `roadmap.md` |
| **Current Sprint** | `roadmap_w1.md` |
| **Current Milestone** | Milestone 1 — Multi-Tenant Bedrock — **COMPLETE** |
| **Current Week** | Week 1 — **COMPLETE** |
| **Next Milestone** | Milestone 2 — Agent & Tool Registries + AES-256-GCM Encryption |
| **Last Updated** | Week 1 — Day 7 Complete |

---

# Current Status

## Sprint Progress

- ✅ Day 1 — Foundation
- ✅ Day 2 — Database & Repository Layer
- ✅ Day 3 — Registration & Email Verification
- ✅ Day 4 — JWT Authentication
- ✅ Day 5 — Tenant Context Middleware
- ✅ Day 6 — Tenant Isolation Validation + Security Review
- ✅ Day 7 — Hardening & Week Review

**Week 1 gate: PASSED.** Week 2 is cleared to begin.

---

## Current Objective

Week 1's objective — prove strict tenant isolation before any agent, tool, or execution surface exists — is met. Day 6 expanded from "write the isolation test" (as originally scoped) into a full adversarial review pass, on the reasoning that a boundary this central deserved more scrutiny than a single proof-checkpoint test would surface. That review found and closed several real gaps before they could become load-bearing for Week 2.

---

# Week 1 — Multi-Tenant Bedrock

---

# Engineering Progress

## Day 1 — Foundation

### Built
- Fastify + TypeScript strict-mode project scaffold
- Zod-based environment validation (`src/config/env.ts`)
- Process fails fast on invalid or missing `AGENTGATE_*` variables
- Structured logging using Pino, pretty-printed in development
- Vitest configured with first passing tests

### Outcome
Established a production-ready project foundation with strict configuration validation and automated testing from day one.

---

## Day 2 — Data Layer

### Built
- PostgreSQL + Redis via Docker Compose
- Prisma schema for Tenant and User
- Soft delete support (`deletedAt`) on both models
- Explicit indexes on `tenantId`, `verificationToken`
- Repository layer (`tenant.repository.ts`, `user.repository.ts`)
- Prisma upgraded to driver-adapter architecture (`@prisma/adapter-pg`)

### Outcome
Established the application's persistence layer while separating business logic from database access.

---

## Day 3 — Registration & Email Verification

### Built
- `POST /auth/register-tenant` with transactional tenant + owner creation
- Argon2 password hashing
- BullMQ email queue with a console-stub worker
- Email verification endpoint and token workflow

### Outcome
Completed the entire registration lifecycle while preparing the project for asynchronous background processing.

---

## Day 4 — Authentication

### Built
- JWT authentication: access tokens (15 min) + refresh tokens (7 day intent, keyed-HMAC hash storage)
- Refresh and logout endpoints
- Authentication preHandler hook
- Protected API endpoint for validation (`/api/ping`, later formalized as `/api/me`)

### Outcome
Completed the authentication system that all future platform functionality builds on.

---

## Day 5 — TenantContext Middleware

### Built
- `TenantContext` Fastify plugin (`decorateRequest` for `tenantContext` and `activeUser`)
- `authenticate` hook (JWT verification)
- `attachTenantContext` hook (JWT claim → `request.tenantContext`)
- `requireActiveIdentity` hook (re-verifies tenant/user are not soft-deleted, on every request — not just at login)
- Protected route group (`/api/me`, `/api/me/details`)
- Graceful shutdown sequence formalized in `server.ts`

### Security Hardening
`attachTenantContext` explicitly validates that every authenticated JWT contains `tenantId`, `userId`, and `role`, and that `role` is one of the whitelisted values. Tokens that verify cryptographically but carry missing or malformed claims are rejected with `401`, before `request.tenantContext` is ever populated. This is a fail-closed design: without it, a structurally valid-but-incomplete JWT could let a downstream Prisma query execute with an `undefined` tenant filter instead of being rejected outright.

`requireActiveIdentity` was added as a third hook specifically so that **soft-deleted tenants and soft-deleted users are rejected on every request**, not only checked at login time. A JWT issued before a deletion remains cryptographically valid until it expires; without this hook, a deactivated account or an offboarded tenant would retain API access for up to 15 minutes after deletion.

### Outcome
The tenant isolation boundary — the single most security-critical piece of Week 1 — was fully wired: JWT verification → claim validation → live-state re-verification → tenant-scoped data access, all enforced at the hook layer rather than left to individual route handlers.

---

## Day 6 — Tenant Isolation Validation + Security Review

Day 6 was scoped in the roadmap as "write the isolation proof test." In practice it expanded into a full adversarial code review of the entire Week 1 surface *before* writing tests against it, on the principle that a test suite built against an unreviewed boundary just formalizes whatever blind spots already exist. That review surfaced six real issues, all closed the same day.

### Findings & Fixes

**1. Type/runtime mismatch on `request.tenantContext` (High)**
`fastify.d.ts` declared `tenantContext: TenantContext` (non-nullable), while the plugin initialized it to `null` at runtime. This is the same failure class as an unguarded `as` cast: the type system would never have warned about a null-pointer read if a route ever executed outside the protected scope, or if hook order were ever broken. `activeUser` was correctly typed nullable right next to it, which is what made the inconsistency obvious.
*Fix:* `tenantContext` retyped as `TenantContext | null`. Introduced `src/lib/request-context.ts` with `getTenantContext(request)` and `getActiveUser(request)` — both throw loudly (rather than silently passing `null` through) if the hook chain didn't populate them. Every route handler in the protected scope now reads through these accessors instead of the raw decorated property.

**2. No global error handler — internal errors could leak to clients (High)**
Fastify's default error handler serializes `error.message` directly into the JSON response for any uncaught exception. Combined with finding #4 below, this meant a duplicate-email registration attempt could leak a raw Prisma constraint message confirming account existence.
*Fix:* `app.setErrorHandler` registered in `app.ts`. Errors with an existing client-facing `statusCode < 500` (from `@fastify/sensible` or schema validation) pass through unchanged; everything else is logged server-side with full detail and returns a generic `500` to the client.

**3. Unguarded `as` cast on `user.role` when signing JWTs (High)**
`auth.service.ts` cast `user.role` (a plain, unconstrained `String` column) to the role union type when signing both access tokens and refresh flows, with zero runtime validation — the same anti-pattern already fixed on the *inbound* JWT-claim side in `attachTenantContext`, just recurring on the *outbound* signing side.
*Fix:* Added `assertValidRole()` in `src/lib/role.ts`; `login()` and `refresh()` now validate before signing rather than casting.

**4. Unhandled unique-constraint violation on duplicate email / slug race (High)**
`registerTenant()` checked slug uniqueness at the application layer only (a TOCTOU race under concurrent requests) and had no equivalent check for email at all — both are enforced only by the DB's `@unique` constraint. A genuine Prisma `P2002` was uncaught, surfacing as an unhandled 500 (and, combined with #2, a potential email-enumeration leak).
*Fix:* `registerTenant()` now catches `Prisma.PrismaClientKnownRequestError` with code `P2002`, inspects `err.meta.target`, and maps to `EMAIL_TAKEN` / `SLUG_TAKEN` / `DUPLICATE_ENTRY`. `register.ts` route now returns clean `409`s for all three.

**5. Unscoped, unused repository method (Medium)**
`userRepository.findByIdOnly()` performed a lookup with no tenant filter, left over from an earlier refresh-flow design that has since been superseded by hash-based lookup. Its own comment claimed it "avoids tenant leakage," which was backwards. Unused in current code, but a latent IDOR surface if reached for later under a false sense of safety.
*Fix:* Removed. If an internal, deliberately-unscoped lookup is needed later (e.g. a background worker with no request-scoped tenant), it should be reintroduced under a name that cannot be mistaken for safe, e.g. `findByIdUnscoped_InternalOnly`.

**6. `Fastify.FastifyInstance` used as a type (compile error)**
`createApp()`'s return type referenced `Fastify.FastifyInstance` off the default import — but `fastify`'s types are named exports, not a namespace merged onto the default. This broke type-checking for the entire file, which is why the error appeared to originate "around" unrelated code (`setErrorHandler`) added in the same pass.
*Fix:* Switched to `import Fastify, { type FastifyInstance, type FastifyError } from "fastify"` and typed the return value and error-handler parameter explicitly.

### Test Suite Delivered

- **`tenant-isolation.test.ts`** — cross-tenant reads on both `/api/me` and `/api/me/details`; header/query tenant-override injection (`X-Tenant-Override`, `?tenantId=`); soft-deleted tenant and soft-deleted user rejected on both endpoints (tested as two distinct scenarios, since they exercise different halves of the compound `deletedAt` filter); missing/forged/malformed/expired JWTs; public-route accessibility check as a negative-space control.
- **`auth.e2e.test.ts`** — full lifecycle: register → pre-verification login rejected → verify → login → access → refresh → logout → post-logout refresh denied. Includes an explicit assertion that wrong-password and nonexistent-email failures are indistinguishable (no enumeration).
- **`auth.register-edge-cases.test.ts`** — regression test written specifically to fail before finding #4's fix and pass after it; retained as a permanent guard against the P2002 gap reopening.

### Test Infrastructure

- `test-tenant.factory.ts` centralizes tenant/user provisioning (`createTestTenant`) and teardown (`cleanupTenant`) so Week 2+ suites don't duplicate fixture logic. Hardened during review to assert on the status of each intermediate `app.inject()` call, so a fixture failure surfaces at its actual cause instead of three lines later as a confusing `findUniqueOrThrow` error.
- `cleanupTenant()` deletes exactly the tenant it's given (relying on `onDelete: Cascade`) rather than a blanket `deleteMany()` — deliberately chosen to remain safe if the suite ever moves off `fileParallelism: false`.

### Outcome
Every Day 6 gate item passed. The review pass validated that the isolation architecture designed in Day 5 was sound at the structural level, while catching several real gaps in the surrounding trust boundary (error handling, claim validation symmetry, dead-code IDOR surface) that a narrower "just write the proof test" pass would likely have missed.

---

## Day 7 — Hardening & Week Review

### Completed
- `npx tsc --noEmit` — clean, after the `FastifyInstance` typing fix (finding #6)
- Full test suite passing, including the new isolation, e2e, and edge-case files
- Cold-boot validation (`docker compose down && docker compose up -d && npm run dev`) — clean start
- `PASSWORD_PEPPER` confirmed wired via Argon2's `secret` option (closes a previously tracked debt item — see below)
- `refreshTokenHash` index confirmed present in `schema.prisma` (closes a previously tracked debt item)

### Carried forward (not blocking, tracked explicitly below)
- Replace remaining `console.error` calls in `auth.service.ts`'s email-enqueue failure path with the structured `app.log` logger (currently low priority — observability only, not security)
- Repository-layer defense-in-depth: add `tenantId` to the `where` clause of `updateVerified` / `updateRefreshTokenHash` (currently not exploitable, since callers always resolve `id` via a tenant-scoped read first, but inconsistent with the project's "always scope by tenant at the query layer" principle)
- Consider promoting `role` from a plain `String` to a Prisma `enum` for DB-level enforcement, complementing the app-level `assertValidRole()` guard added in Day 6

---

# Architecture Decisions

## Repository Pattern with Explicit Unit of Work

Every repository function accepts:
```ts
client: Prisma.TransactionClient | PrismaClient = prisma
```
The service layer owns transaction boundaries; repositories never begin transactions themselves.
```
Service → Open Transaction → Pass tx explicitly → Repositories
```
**Why:** explicit dependency injection makes transaction boundaries visible. A missing transaction client becomes an immediately detectable bug instead of silently escaping the transaction scope.

## AsyncLocalStorage Deferred

Would remove explicit transaction propagation, but also hides transaction boundaries and introduces implicit behavior. Deliberately delayed until transaction chains are significantly more complex — revisit around Milestone 5 (audit infrastructure).

## Worker / Queue / Connection Separation

```
lib/redis.ts
queues/email.queue.ts
workers/email.worker.ts
server.ts
```
Workers are exposed as factory functions, not module-level instances, so importing a module never implicitly opens a Redis connection or starts consuming jobs during tests. Only `server.ts` controls worker lifecycle.

## app.ts vs server.ts

- **`app.ts`** owns the Fastify instance, plugins, routes, and request lifecycle.
- **`server.ts`** owns the HTTP listener, worker lifecycle, graceful shutdown, and process signals.

**Why:** route tests run via `app.inject()` without needing Redis, BullMQ, or a network listener.

## TenantContext via Fastify Hooks, Not Middleware

Implemented using `decorateRequest` + `preHandler` hooks rather than Express-style middleware, following Fastify's encapsulation model so request context stays lifecycle-aware.

## Fail-Loud Trust-Boundary Accessors (`getTenantContext` / `getActiveUser`)

Introduced Day 6 as a direct consequence of finding #1. Rather than null-checking `request.tenantContext` and `request.activeUser` ad hoc at every read site, both are read through small typed accessor functions that throw if the hook chain didn't populate them. This centralizes the "this must exist by the time a handler runs" assumption in one place, and the resulting thrown error is designed to be caught by the global error handler (also added Day 6) — a hook-ordering bug becomes a logged, generic 500 instead of either a silent bad response or a leaked stack trace.

## Response Schemas as a Second Layer of Defense

Both `/api/me` and `/api/me/details` now declare `required: [...]` on their response schemas, on top of the accessor functions throwing on `null`. This means even a future regression that somehow bypassed the accessor would still be caught at serialization time by `fast-json-stringify` rejecting a partial object, rather than silently emitting `{}`.

---

# Engineering Notes & Debugging Log

## Transaction Boundary Bug (Day 2–3)
Repository methods accepted a transaction client but silently fell back to the global Prisma singleton, so operations expected to run atomically inside `$transaction()` actually ran outside it. **Resolution:** repositories now consistently receive the transaction client explicitly, with no default fallback to the singleton inside a transactional call path.

## Service / Route Error Contract (Day 3–4)
Services threw plain string errors while routes expected Error subclasses, so certain failures returned `500` instead of the intended `400`/`409`. **Resolution:** standardized the error-message contract so known service errors map consistently to HTTP responses.

## Copy-Paste Logic Bugs (Day 3–4)
A variable named `existingUser` was actually checking tenant slug uniqueness. **Resolution:** renamed to accurately describe purpose.

## BullMQ + ioredis Type Conflict (Day 3)
BullMQ installed its own physical copy of `ioredis`, so TypeScript treated the `Redis` class from BullMQ and the project's own `Redis` import as incompatible. **Resolution:** `"overrides": { "ioredis": "$ioredis" }` in `package.json`, forcing a single physical installation.

## Type/Runtime Mismatch on `tenantContext` (Day 6)
See Finding #1 above. Notable because it's structurally identical to a bug already fixed once (the `attachTenantContext` unguarded `as` cast on inbound JWT claims) — the same class of error recurred in the type declaration rather than the hook body. Worth remembering as a pattern: **any place a value flows into a security decision without a runtime guard is a candidate for this bug, regardless of whether it's a cast, a type declaration, or a default value.**

## `Fastify.FastifyInstance` Compile Error (Day 6)
See Finding #6 above. Notable because the error appeared to originate in `setErrorHandler` (added in the same edit) when the actual cause was the function signature two lines above it — a reminder that a single bad type reference can make an entire file's diagnostics look like they're coming from wherever code was most recently touched.

---

# Known Technical Debt

| Item | Current State | Planned Resolution |
|------|---------------|-------------------|
| Refresh token rotation | Single refresh token hash, no rotation on use | Dedicated `refresh_tokens` table with rotation + reuse detection |
| Multi-device sessions | New login invalidates previous session | Solved alongside refresh token table |
| Auth endpoint rate limiting | Not implemented | `@fastify/rate-limit` as an interim measure, or full Redis Lua limiter at Milestone 3 |
| AsyncLocalStorage | Deferred | Revisit around Milestone 5 (audit infrastructure) |
| `console.error` in `auth.service.ts` email-enqueue path | Inconsistent with structured Pino logging used elsewhere | Replace with `app.log` / shared logger — low priority, observability only |
| `updateVerified` / `updateRefreshTokenHash` not tenant-scoped in `where` clause | Not currently exploitable (id resolved via tenant-scoped read first) | Add `tenantId` to `where` clause for defense-in-depth consistency |
| `role` column is plain `String`, not a Prisma `enum` | App-level guard (`assertValidRole`) added Day 6 | Optional: promote to enum for DB-level enforcement |
| Shared ioredis connection reused across BullMQ `Queue` and future rate limiter | Fine today; BullMQ recommends dedicated connections per consumer | Give the Week 3 rate limiter (and BullMQ) their own ioredis instances |

**Resolved this week (previously tracked):**
- ~~Argon2 pepper~~ — done via `secret` option, environment-backed (`PASSWORD_PEPPER`)
- ~~Missing index on `refreshTokenHash`~~ — confirmed present in `schema.prisma`
- ~~Unscoped `findByIdOnly` repository method~~ — removed (Day 6, Finding #5)

---

# Day 6 Validation Gate — Result

- [x] Tenant A cannot access Tenant B data (proven on both `/api/me` and `/api/me/details`)
- [x] Header spoofing attempts fail (`X-Tenant-Override` header, `?tenantId=` query param both proven inert)
- [x] Forged JWT rejected
- [x] Missing JWT claims rejected
- [x] Tampered JWT rejected
- [x] Invalid/whitelist-violating role claim rejected
- [x] Expired JWT rejected
- [x] Soft-deleted tenant rejected (both protected endpoints)
- [x] Soft-deleted user rejected (both protected endpoints)
- [x] Public routes remain reachable without a token

**Gate: PASSED.**

---

# Day 7 Hardening — Result

- [x] `npx tsc --noEmit` — clean
- [x] Cold boot validation (`docker compose down/up` → `npm run dev`)
- [x] Full test suite passes (tenant isolation, e2e lifecycle, registration edge cases)
- [x] Docker restart validation
- [ ] Remove remaining `console.log`/`console.error` (one instance carried forward, see debt table — non-blocking)
- [x] Week 1 Completion Report (below)

---

# Engineering Metrics

| Metric | Status |
|---------|--------|
| Week Progress | 7 / 7 Days |
| Milestone Progress | 100% |
| TypeScript | 🟢 Clean (`tsc --noEmit`) |
| Test Suite | 🟢 Passing |
| Overall Health | 🟢 Stable |

---

# Week 1 Completion Report

## Week 1 Deliverables

- [x] Multi-tenant foundation complete
- [x] Authentication complete (register, verify, login, refresh, logout)
- [x] TenantContext complete (JWT → claims → live-state re-verification)
- [x] Tenant isolation validated (adversarial review + full test suite)
- [x] Graceful shutdown verified

## Engineering Validation

- [x] Tenant isolation proof test passes
- [x] Forged JWT rejected
- [x] Tampered JWT rejected
- [x] Missing JWT claims rejected
- [x] No plaintext passwords stored (Argon2 + pepper, verified via direct DB read in `auth.e2e.test.ts`)
- [x] No plaintext refresh tokens stored (keyed HMAC-SHA256, lookup-safe, non-reversible without `REFRESH_TOKEN_SECRET`)
- [x] Zero TypeScript errors (`npx tsc --noEmit`)
- [x] All Week 1 tests passing

## Deferred to Week 2

- Agent Management (CRUD, API key generation + rotation via Argon2)
- Tool Registry (CRUD, JSON Schema input validation via AJV)
- API Key Authentication (distinct from user JWT auth — agents are not interactive)
- AES-256-GCM Tool Configuration Encryption

## Week 1 Retrospective

**Major architectural decisions.** The decision that mattered most this week was treating `TenantContext` as a three-stage pipeline (`authenticate` → `attachTenantContext` → `requireActiveIdentity`) rather than a single hook. Splitting "is this JWT valid" from "does this JWT carry complete claims" from "is the account/tenant this JWT refers to still active" made each stage independently testable and meant the soft-delete enforcement (a Day 5 addition beyond the original roadmap scope) could be added without touching the other two.

**Lessons learned.** The most useful lesson from Day 6 is that the same class of bug — a value trusted without a runtime guard at the point it crosses a security boundary — showed up in three unrelated places this week: an inbound JWT claim cast, an outbound JWT-signing cast, and a type declaration's nullability. None of the three were caught by the same mechanism; each needed a dedicated look. That's the argument for doing a full adversarial review pass at the end of a foundational milestone, rather than relying solely on the single proof-checkpoint test the roadmap originally scoped for Day 6 — the checkpoint test proves the *intended* design works; it doesn't by itself surface where the design was inconsistently applied.

**Technical challenges encountered.** The `Fastify.FastifyInstance`-as-a-type compile error was a good reminder that a broken type reference can make unrelated, correctly-written code (the new global error handler) look like the source of the problem, simply because it was in the same diff. Worth flagging early with `tsc --noEmit` rather than debugging by inspection when something "looks wrong" in an editor.

**Remaining technical debt.** Nothing on the current debt table (see above) blocks Week 2. Rate limiting on auth endpoints is the item most worth revisiting early, given the 8-character password minimum and no current throttle — Milestone 3's Redis-based limiter resolves this, but it's worth a conscious decision on whether a interim `@fastify/rate-limit` stopgap is warranted before then.

**Readiness assessment.** Week 1's core deliverable — a tenant isolation boundary that is provably correct rather than assumed correct — is met. Milestone 2 (Agent & Tool Registries + encryption) can begin.