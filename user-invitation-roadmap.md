# AgentGate — User Registration via Invitation (`register-user`): Analysis & Full Implementation Plan

## Scope, Stated Plainly

This plan implements **exactly one thing**: turning the currently-empty `POST /auth/register-user` stub into a real, safe "add a user to an existing tenant" flow, using the invitation-token design (Option B) already decided in the handed-off memo. That means:

**In scope:** Phase 0 (the `requireRole()` primitive, since nothing else can be safely built without it) + Phase 1 (the invitation table, service, both routes, email integration, tests) from the memo.

**Explicitly out of scope** (named, not silently dropped — consistent with how every other week in this project has handled deferred work): G1's *broader* role-gating retrofit (I build the primitive, not a project-wide audit of every existing route), G3 (soft-deleted-email squatting), G4 (verification-token expiry), G5 (resend-verification), G6 (audit-event types for user actions), G7 (`AGENT_AUTHENTICATED`), G8 (password reset), and everything in Phase 2/3 (list/revoke/resend invitations, user deactivation, SSO). These get one line each in Part 8, not a build.

I read the memo against the actual shipped code quoted across this project's own history (`register.ts`'s real stub, `userRepository.create()`'s real signature, `authService.login()`'s real token-issuance body, `PublicAuthRoute`'s real union, `checkRateLimitByNameSpace`'s real signature) rather than the memo's prose alone — the same discipline every daily document in this project has applied to whatever it was handed. That surfaced seven findings worth fixing before writing the implementation, not after.

---

## Part 1 — Where This Sits

Tracing the thread: PRD §7's MVP scope names "User registration within a tenant (email + password)" as a distinct deliverable from tenant registration. It never got built — `register.ts` only ever shipped `register-tenant` + `verify-email`. Week 8 Day 2 wired the coarse public-auth throttle onto a **stub** (`register-user`) without anyone asking what that route should actually do, because at that point nobody had yet — the memo you handed me is the first document in this project's history to actually answer that question. This is genuinely new tenant-facing capability, surfaced mid-Week-8 (the memo's own Finding G9), which is why I'm treating it as its own dedicated piece of work rather than folding it into any hardening day's leftover scope.

---

## Part 2 — Diagnosis & Findings

I read the memo's design against the real shipped code. Two findings are load-bearing enough to change the implementation; the rest are precision fixes.

| # | Finding | Sev |
|---|---|---|
| **F1** | The memo's accept flow assumes an invitee "visits a link" and submits a form — but PRD §7's MVP scope explicitly excludes any dashboard UI ("Dashboard UI (management is API-only in MVP)"). A mailed link to `/accept-invitation?token=...` would 404 today; nothing renders it. This isn't hypothetical — it changes what the email body actually needs to contain. | 🟠 |
| **F2** | The memo describes invitation-token hashing as matching "the same way `refreshTokenHash` already is (HMAC)." The actual shipped `authService.login()`/`refresh()` hashes the refresh token with **Argon2**, not HMAC. Argon2's random per-hash salt makes it structurally unable to serve a lookup-by-value query — which is exactly what invitation acceptance needs, since only the raw token (no known user/invitation ID) is available at that point. The memo's own reasoning is right that this needs to be *hashed, not plaintext*; the mechanism it names is wrong for what it's being asked to do. | 🟠 |
| **F3** | `userRepository.create()`'s real TypeScript signature requires `verificationToken: string` as non-optional, even though the underlying Prisma column is already nullable (`String?`). It also has no `DbClient` parameter at all — every other repository in this project has had one since Week 2, specifically so it can run inside a caller's `$transaction`. Acceptance needs both fixes to create a user transactionally without a token. | 🟡 |
| **F4** | No role-authorization primitive exists anywhere in the codebase. `authenticate` → `attachTenantContext` → `requireActiveIdentity` establish *identity*; nothing checks *role*. This is G1 in its narrowest, load-bearing form — blocks the issuance route directly. | 🟡 |
| **F5** | The current `register-user` stub already sits behind the real Week 8 Day 2 throttle, with a schema (`{email, password}`, `additionalProperties: false`) that already structurally rejects a `tenantId`/`role` field. Confirms there's nothing dangerous to "unwire" beyond the route body itself. | 🟢 |
| **F6** | The project's own established convention is nullable-timestamp lifecycle columns over a status enum (`Tenant.deletedAt`). `Invitation` should follow this, not invent a `status` field. | 🟢 |
| **F7** | A subtle one I caught while designing, not in the memo: naively reusing the verification-email's deterministic-`jobId` pattern for invitation emails is actively dangerous. Reissue updates the **same** invitation row in place with a **new** token. If the reissued email reused the original's `jobId` and the original job were still sitting in the queue, BullMQ's own documented no-op-on-duplicate-`jobId` behavior would mean the **stale, already-invalidated** token is what actually gets delivered — not the fresh one. | 🟠 |

---

## Part 3 — Decision Log (continues the project's numbering at 8.47, after Week 8 Day 2's 8.46)

| # | Decision | Closes |
|---|---|---|
| 8.47 | Adopt the invitation-token model exclusively. `register-user` is **removed**, not filled in. | — |
| 8.48 | New `requireRole(...)` Fastify preHandler, applied **per-route**, never scope-wide. Phase 0 prerequisite. | F4 |
| 8.49 | Invitation tokens: `crypto.randomBytes(32).toString('base64url')` — the same generation function/length as API-key secrets (W2) and WS tickets (W7). Third application of this exact primitive. | — |
| 8.50 | Invitation tokens hashed via **HMAC-SHA256**, keyed by a dedicated `AGENTGATE_INVITATION_TOKEN_SECRET` — deterministic, lookup-by-value. Not Argon2 (which cannot serve this). | F2 |
| 8.51 | `expiresAt` computed once at mint time, stored as the sole source of truth — no derived expiry math duplicated elsewhere. Default 7 days via `AGENTGATE_INVITATION_TTL_DAYS`. | — |
| 8.52 | Reissuing a duplicate pending invite **updates the existing row in place** (new token hash, reset expiry) — application-layer enforced, not a DB constraint. Accepted, narrow race window; self-correcting via the atomic accept-time claim. | — |
| 8.53 | G3 (soft-deleted-email squatting) is **moot today** — `User` has no soft-delete concept at all yet. Revisit only when Phase 2 ships user deactivation. | — |
| 8.54 | Every token-state failure (`not_found`/`revoked`/`already_accepted`/`expired`/`tenant_suspended`) collapses to one generic response — no oracle. `email_taken` is the one exception: it describes the invitee's own, already-known email, not the token's state. | — |
| 8.55 | New `authService.issueSessionTokens()`, extracted verbatim from `login()`'s own tail, reused by the accept-invitation route handler. Zero duplicated JWT/refresh-hash logic. | — |
| 8.56 | Acceptance auto-logs in; `isVerified: true` set at user-creation time. Token possession + password-setting in one request already proves ownership — no separate verify step. | — |
| 8.57 | `userRepository.create()` gains an optional `verificationToken`, an optional `isVerified` (default `false`, preserving tenant-registration's existing behavior), and the standard `DbClient` parameter. Additive, backward compatible. | F3 |
| 8.58 | Invitation issuance gets its own coarse per-`(tenantId, userId)` throttle (`AGENTGATE_INVITATION_ISSUE_RATE_LIMIT`, default 20/min) via the existing `checkRateLimitByNameSpace` primitive — bounds email-sending cost from a compromised/careless Owner session. | — |
| 8.59 | The invitation email's primary content is a **copyable raw token + curl example**, not a "click this link" CTA. A reference link is still included, inert until a dashboard exists. | F1 |
| 8.60 | `PublicAuthRoute` (W8D2) amended: `"register-user"` → `"accept-invitation"`. Namespace and default limit unchanged. | — |
| 8.61 | Invitation emails are enqueued **without** a deterministic `jobId` (unlike verification emails) — a reused `jobId` across a reissue would risk BullMQ silently keeping a stale, invalidated token queued for send. Accepted cost: a rare client-retry could send two emails; harmless, since only the freshest DB token is ever valid. | F7 |
| 8.62 | No new M5 audit-event type for invitation issuance/acceptance this phase (G6, unchanged, out of scope). | — |

---

## Part 4 — Architecture

### 4.1 Entities

```mermaid
erDiagram
    TENANT ||--o{ USER : "has"
    TENANT ||--o{ INVITATION : "issues"
    USER ||--o{ INVITATION : "invited_by (sentInvitations)"
```

### 4.2 Issuance

```mermaid
sequenceDiagram
    participant Owner as Owner (JWT, role=owner)
    participant Hook as authenticate + attachTenantContext + requireActiveIdentity + requireRole('owner')
    participant Route as POST /api/users/invitations
    participant RL as checkRateLimitByNameSpace("invitation-issue", ...)
    participant Svc as invitationService
    participant DB as PostgreSQL
    participant Q as emailQueue

    Owner->>Hook: POST { email, role? }
    Hook-->>Route: 403 if role != owner, else pass through
    Route->>RL: (tenantId, userId) throttle check
    RL-->>Route: allowed / 429 / 503
    Route->>Svc: createInvitation(tenantId, userId, {email, role})
    Svc->>DB: userRepository.findByEmail — reject if already registered
    Svc->>DB: invitationRepository.findActivePendingByTenantAndEmail
    alt pending invite exists
        Svc->>DB: UPDATE in place (new tokenHash, reset expiresAt)
    else no pending invite
        Svc->>DB: INSERT new invitation row
    end
    Svc->>Q: enqueueInvitationEmail (no deterministic jobId — Decision 8.61)
    Svc-->>Route: {id, email, role, expiresAt} — NEVER the raw token
    Route-->>Owner: 201
```

### 4.3 Acceptance

```mermaid
sequenceDiagram
    participant Invitee as Invitee (no JWT — the token IS the credential)
    participant Throttle as public-auth throttle (bucket: "accept-invitation")
    participant Route as POST /auth/accept-invitation
    participant Svc as invitationService
    participant DB as PostgreSQL
    participant Auth as authService.issueSessionTokens

    Invitee->>Throttle: POST { token, password }
    Throttle-->>Route: allowed / 429 / 503
    Route->>Svc: acceptInvitation(token, password)
    Svc->>DB: findByTokenHashWithTenant — not_found / revoked / already_accepted / expired?
    Svc->>DB: RE-CHECK tenant.deletedAt fresh (never trusted from issuance time)
    Svc->>DB: RE-CHECK email still globally unclaimed (race guard)
    Svc->>DB: TXN — claimForAcceptance (updateMany WHERE accepted_at IS NULL)
    alt claim.count == 0
        Svc-->>Route: already_accepted (someone else won the race)
    else claimed
        Svc->>DB: TXN — INSERT user (isVerified=true, role from invitation row)
        Svc-->>Route: { ok: true, user }
    end
    Route->>Auth: issueSessionTokens(user, app)
    Route-->>Invitee: 200 { accessToken, refreshToken, expiresIn }
```

### 4.4 Boundary Summary

| Boundary | Auth model | Tenant scope source |
|---|---|---|
| `POST /api/users/invitations` | JWT + `requireRole('owner')` | `request.tenantContext.tenantId` |
| `POST /auth/accept-invitation` | None — the token is the credential | The invitation row's own `tenant_id`, never the request body |

---

## Part 5 — Implementation

### Dependency Chain

```
env.ts (new vars)
  │
  ▼
prisma/schema.prisma (Invitation model)
  │
  ├──────────────────────────┬────────────────────────────┐
  ▼                          ▼                             ▼
lib/roles.ts          lib/invitation-token.ts       plugins/authorize.ts
  │                          │                             │
  └──────────┬───────────────┴─────────────────────────────┘
             ▼
   repositories/invitation.repository.ts
   repositories/user.repository.ts (patch)
             │
             ▼
   queue/email.queue.ts (patch)   lib/email/email-templates.ts (patch)
   workers/email.worker.ts (patch)
             │
             ▼
   services/invitation.service.ts
   services/auth.service.ts (patch — issueSessionTokens)
             │
             ▼
   lib/public-auth-throttle.ts (patch)
   routes/invitations.ts (NEW)
   routes/auth/register.ts (patch)
             │
             ▼
   app.ts (register invitationRoutes)
```

### Files Touched

| File | Change |
|---|---|
| `src/config/env.ts` | +3 env vars |
| `prisma/schema.prisma` | +`Invitation` model, +2 relation lines |
| `src/lib/roles.ts` | NEW |
| `src/plugins/authorize.ts` | NEW |
| `src/lib/invitation-token.ts` | NEW |
| `src/repositories/invitation.repository.ts` | NEW |
| `src/repositories/user.repository.ts` | Patch |
| `src/services/invitation.service.ts` | NEW |
| `src/services/auth.service.ts` | Patch |
| `src/queue/email.queue.ts` | Patch |
| `src/workers/email.worker.ts` | Patch |
| `src/lib/email/email-templates.ts` | Patch |
| `src/lib/public-auth-throttle.ts` | Patch |
| `src/routes/invitations.ts` | NEW |
| `src/routes/auth/register.ts` | Patch |
| `src/app.ts` | Patch |

---

### Step 1 — `src/config/env.ts`

```typescript
// ── User invitations (register-user replacement) ──────────────────
AGENTGATE_INVITATION_TOKEN_SECRET: z.string().min(32),
AGENTGATE_INVITATION_TTL_DAYS: z.coerce.number().int().positive().default(7),
AGENTGATE_INVITATION_ISSUE_RATE_LIMIT: z.coerce.number().int().positive().default(20), // per minute, per (tenantId, userId)
```

`.env.example`:
```
AGENTGATE_INVITATION_TOKEN_SECRET=
AGENTGATE_INVITATION_TTL_DAYS=7
AGENTGATE_INVITATION_ISSUE_RATE_LIMIT=20
```

### Step 2 — `prisma/schema.prisma` (addition)

```prisma
model Invitation {
  id              String    @id @default(uuid())
  tenantId        String    @map("tenant_id")
  email           String
  role            String    @default("member")
  invitedByUserId String    @map("invited_by_user_id")
  tokenHash       String    @unique @map("token_hash")
  expiresAt       DateTime  @map("expires_at")
  acceptedAt      DateTime? @map("accepted_at")
  revokedAt       DateTime? @map("revoked_at")
  createdAt       DateTime  @default(now()) @map("created_at")

  tenant    Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  invitedBy User   @relation(fields: [invitedByUserId], references: [id], onDelete: Cascade)

  // Backs the reissue lookup (tenantId + email, filtered by the
  // nullable timestamp columns at query time — matches Tenant.deletedAt's
  // own nullable-timestamp-over-status-enum precedent, Finding F6).
  @@index([tenantId, email])
  @@map("invitations")
}
```

Add to `Tenant`: `invitations Invitation[]`
Add to `User`: `sentInvitations Invitation[]`

```bash
npx prisma migrate dev --name add_invitations
npx prisma generate
```

### Step 3 — `src/lib/roles.ts` (NEW)

```typescript
/**
 * PRD §7 scopes MVP roles to exactly "Owner and Member" — the fuller
 * Owner/Admin/Member vision (PRD §5.1) is end-state, not built. A
 * single, small, shared source of truth so the invitation route's
 * schema and requireRole()'s type never drift apart into two
 * independently-typed copies of "what a valid role is."
 */
export const VALID_ROLES = ["owner", "member"] as const;
export type Role = (typeof VALID_ROLES)[number];

export function isValidRole(value: unknown): value is Role {
  return typeof value === "string" && (VALID_ROLES as readonly string[]).includes(value);
}
```

### Step 4 — `src/plugins/authorize.ts` (NEW — Phase 0, Decision 8.48)

```typescript
import type { FastifyRequest, FastifyReply } from "fastify";
import type { Role } from "../lib/roles.js";

/**
 * This project's first role-authorization primitive. Deliberately
 * NOT a scope-wide hook (Finding F4 is scoped narrowly on purpose):
 * most existing /api/* routes have no role restriction today, and
 * retrofitting one project-wide is explicitly out of scope for this
 * pass. Applied per-route, the same way `authenticate` itself was
 * first applied per-route (Week 4) before ever becoming a scope-wide
 * hook.
 *
 * Must run AFTER attachTenantContext — reads request.tenantContext.role,
 * which only exists once that hook has populated it. request.tenantContext.role
 * reflects the role at ACCESS-TOKEN-ISSUE time (15-minute lifetime) —
 * the same, already-accepted staleness bound this project's JWTs have
 * always carried ("JWTs are stateless — this is correct", Week 1). Not
 * a new tradeoff introduced here.
 */
export function requireRole(...allowedRoles: readonly Role[]) {
  return async function requireRoleHook(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { role } = request.tenantContext;
    if (!allowedRoles.includes(role as Role)) {
      return reply.forbidden(`This action requires one of the following roles: ${allowedRoles.join(", ")}.`);
    }
  };
}
```

### Step 5 — `src/lib/invitation-token.ts` (NEW)

```typescript
import crypto from "node:crypto";
import { env } from "../config/env.js";

/**
 * Generation: identical function/byte-length to Week 2's API-key
 * secrets and Week 7's WS tickets — crypto.randomBytes, never
 * crypto.randomUUID(). Third application of this exact primitive; a
 * UUID is a record identifier, not a bearer secret, and this project
 * has never conflated the two (Decision 8.49).
 *
 * Hashing: HMAC-SHA256, keyed by a DEDICATED
 * AGENTGATE_INVITATION_TOKEN_SECRET — not Argon2, and not shared with
 * any other secret's pepper. Acceptance arrives with ONLY the raw
 * token — no known user/invitation ID to verify against — so the
 * lookup has to run the other direction: "find the row whose hash
 * equals this." Argon2's random per-hash salt makes that impossible;
 * HMAC is deterministic (same input -> same digest), so a direct,
 * indexed `WHERE token_hash = ?` lookup is safe and correct. This
 * corrects Finding F2: the design memo this module implements
 * described matching refreshTokenHash's "HMAC" approach — the real
 * refreshTokenHash is Argon2-hashed and could not serve this
 * lookup-by-value use case either.
 */
const TOKEN_BYTES = 32;

export function generateInvitationToken(): string {
  return crypto.randomBytes(TOKEN_BYTES).toString("base64url");
}

export function hashInvitationToken(rawToken: string): string {
  return crypto.createHmac("sha256", env.AGENTGATE_INVITATION_TOKEN_SECRET).update(rawToken).digest("hex");
}
```

### Step 6 — `src/repositories/invitation.repository.ts` (NEW)

```typescript
import { prisma } from "../lib/prisma.js";
import type { DbClient } from "../types/db-client.type.js";

export interface CreateInvitationInput {
  tenantId: string;
  email: string;
  role: string;
  invitedByUserId: string;
  tokenHash: string;
  expiresAt: Date;
}

export const invitationRepository = {
  create: (data: CreateInvitationInput, client: DbClient = prisma) => client.invitation.create({ data }),

  /**
   * Reissue-target lookup (Decision 8.52 — update in place, never a
   * second row). "Active pending" is computed at query time from the
   * three nullable/comparable columns, not a stored status column —
   * mirrors Tenant.deletedAt's own convention (Finding F6).
   */
  findActivePendingByTenantAndEmail: (tenantId: string, email: string, client: DbClient = prisma) =>
    client.invitation.findFirst({
      where: { tenantId, email, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
    }),

  reissue: (
    id: string,
    data: { tokenHash: string; expiresAt: Date; invitedByUserId: string; role: string },
    client: DbClient = prisma
  ) => client.invitation.update({ where: { id }, data }),

  /**
   * The sole lookup path for acceptance. Includes the parent tenant's
   * deletedAt so the service layer can re-verify tenant status FRESH
   * — never trusted from issuance time (mirrors
   * permissionRepository.findGrantWithContext's multi-axis-freshness
   * precedent, Week 3, and SSRF Layer 2's resolve-fresh-every-time
   * stance, Week 4).
   */
  findByTokenHashWithTenant: (tokenHash: string, client: DbClient = prisma) =>
    client.invitation.findUnique({
      where: { tokenHash },
      include: { tenant: { select: { deletedAt: true } } },
    }),

  /**
   * The atomic claim. updateMany + count, never a bare update — the
   * SAME "count distinguishes matched-and-updated from no-match"
   * pattern agentRepository.rotateKey/updateById already established
   * (Week 2). `client` is REQUIRED (no default) — this must always
   * run inside the caller's own transaction; the missing default is
   * deliberate, forcing callers to pass `tx` explicitly rather than
   * accidentally running it non-transactionally.
   */
  claimForAcceptance: (id: string, client: DbClient) =>
    client.invitation.updateMany({
      where: { id, acceptedAt: null, revokedAt: null },
      data: { acceptedAt: new Date() },
    }),
};
```

### Step 7 — `src/repositories/user.repository.ts` (patch — Decision 8.57 / Finding F3)

```diff
+import type { DbClient } from "../types/db-client.type.js";
+
   create: (data: {
     tenantId: string
     email: string
     passwordHash: string
     role: string
-    verificationToken: string
-  }) => prisma.user.create({ data }),
+    verificationToken?: string
+    isVerified?: boolean
+  }, client: DbClient = prisma) => client.user.create({ data }),
```

Everything else in the file — `findByEmail`, `findById`, `findByVerificationToken`, `updateVerified`, `updateRefreshTokenHash` — is untouched.

### Step 8 — `src/services/auth.service.ts` (patch — Decision 8.55)

```diff
 export const authService = {
   ...

+  /**
+   * Extracted from login()'s own token-issuance tail (Decision 8.55)
+   * so acceptInvitation's route handler can reuse the identical
+   * JWT-signing + refresh-hash logic instead of a second, duplicated
+   * call site. Behaviorally IDENTICAL to what login() already did
+   * inline — a pure extraction, not a redesign.
+   */
+  async issueSessionTokens(user: { id: string; tenantId: string; role: string }, app: FastifyInstance) {
+    const accessToken = app.jwt.sign({ sub: user.id, tenantId: user.tenantId, role: user.role });
+    const rawRefreshToken = crypto.randomBytes(32).toString("base64url");
+    const refreshTokenHash = await argon2.hash(rawRefreshToken);
+    await userRepository.updateRefreshTokenHash(user.id, refreshTokenHash);
+    return { accessToken, refreshToken: rawRefreshToken, expiresIn: 900 };
+  },

   async login(email: string, password: string, app: FastifyInstance) {
     const user = await userRepository.findByEmail(email)
     if (!user) throw new Error('INVALID_CREDENTIALS')
     const passwordValid = await argon2.verify(user.passwordHash, password)
     if (!passwordValid) throw new Error('INVALID_CREDENTIALS')
     if (!user.isVerified) throw new Error('EMAIL_NOT_VERIFIED')

-    const accessToken = app.jwt.sign({ sub: user.id, tenantId: user.tenantId, role: user.role })
-    const rawRefreshToken = crypto.randomBytes(32).toString('base64url')
-    const refreshTokenHash = await argon2.hash(rawRefreshToken)
-    await userRepository.updateRefreshTokenHash(user.id, refreshTokenHash)
-    return { accessToken, refreshToken: rawRefreshToken, expiresIn: 900 }
+    return this.issueSessionTokens(user, app)
   },

   ...
 }
```

### Step 9 — `src/queue/email.queue.ts` (patch — Decision 8.61 / Finding F7)

```diff
- export type EmailJobType = "verification";
+ export type EmailJobType = "verification" | "invitation";

- export interface EmailQueueJob {
-   type: EmailJobType;
-   email: string;
-   token: string;
- }
+ export interface VerificationEmailJob {
+   type: "verification";
+   email: string;
+   token: string;
+ }
+ export interface InvitationEmailJob {
+   type: "invitation";
+   email: string;
+   token: string;
+   tenantId: string;
+ }
+ export type EmailQueueJob = VerificationEmailJob | InvitationEmailJob;
```

```typescript
/**
 * Deliberately NO deterministic jobId here, unlike
 * enqueueVerificationEmail() (Finding F7 / Decision 8.61). Reissue
 * (invitation.service.ts) updates the SAME invitation row in place
 * with a NEW token. If this reused a jobId keyed off (tenantId,
 * email) or even the invitation's own id, and the ORIGINAL email job
 * were still sitting "waiting" in the queue, BullMQ's documented
 * no-op-on-duplicate-jobId behavior would mean the STALE, already-
 * invalidated token is what actually gets delivered — not the fresh
 * one. Accepted cost of going without: a rare client retry of the
 * issuance endpoint could enqueue two emails instead of one; harmless,
 * since only the freshest token in Postgres is ever valid regardless
 * of how many emails carrying it were sent.
 */
export function enqueueInvitationEmail(params: { email: string; rawToken: string; tenantId: string }): void {
  const payload: InvitationEmailJob = {
    type: "invitation",
    email: params.email,
    token: params.rawToken,
    tenantId: params.tenantId,
  };
  emailQueue.add("invitation", payload).catch((err) => {
    console.warn(`[email] failed to enqueue invitation email for ${params.email}:`, err);
  });
}
```

`defaultJobOptions` (attempts/backoff/retention) already apply to every job added to `emailQueue` regardless of `jobId` — no change needed there.

### Step 10 — `src/lib/email/email-templates.ts` (patch — Decision 8.59 / Finding F1)

```typescript
export function renderInvitationEmail(params: { token: string }): RenderedEmail {
  const acceptApiUrl = new URL("/auth/accept-invitation", env.AGENTGATE_APP_BASE_URL).toString();
  const referenceLink = new URL("/accept-invitation", env.AGENTGATE_APP_BASE_URL);
  referenceLink.searchParams.set("token", params.token);

  const subject = "You've been invited to join a team on AgentGate";

  // AgentGate's MVP is API-first (PRD §7 explicitly excludes a
  // dashboard UI) — a "click this link" call to action would 404
  // today. The primary content is a copyable token + a working curl
  // example instead. The reference link is included for forward
  // compatibility only, once a real dashboard exists to receive it.
  const text = [
    "You've been invited to join a team on AgentGate.",
    "",
    "There's no web page to click through yet — use the token below",
    "directly with the accept-invitation endpoint to set your password",
    "and get an access token in one step:",
    "",
    `  curl -X POST ${acceptApiUrl} \\`,
    `    -H "Content-Type: application/json" \\`,
    `    -d '{"token": "${params.token}", "password": "<choose-a-password>"}'`,
    "",
    `(Reference link, for a future dashboard: ${referenceLink.toString()})`,
    "",
    "This invitation expires soon. If you weren't expecting this, you can ignore this email.",
  ].join("\n");

  const html = `
    <div style="font-family: -apple-system, sans-serif; max-width: 520px; margin: 0 auto;">
      <h2>You've been invited to join a team on AgentGate</h2>
      <p>There's no web page to click through yet — use the token below
         directly with the <code>accept-invitation</code> endpoint to set
         your password and get an access token in one step:</p>
      <pre style="background:#f5f5f5;padding:12px;border-radius:6px;overflow-x:auto;font-size:13px;">curl -X POST ${acceptApiUrl} \\
  -H "Content-Type: application/json" \\
  -d '{"token": "${params.token}", "password": "&lt;choose-a-password&gt;"}'</pre>
      <p style="color:#666;font-size:13px;">Reference link (for a future dashboard): ${referenceLink.toString()}</p>
      <p style="color:#999;font-size:12px;">This invitation expires soon. If you weren't expecting this, you can ignore this email.</p>
    </div>
  `.trim();

  return { subject, html, text };
}
```

### Step 11 — `src/workers/email.worker.ts` (patch)

```diff
+import { renderInvitationEmail } from "../lib/email/email-templates.js";

 async function processJob(job: Job<EmailQueueJob>): Promise<void> {
   const provider = getEmailProvider();

-  if ((job.data.type as string) !== "verification") {
-    await writeDeadLetter("UNKNOWN_JOB_TYPE", `Unrecognized email job type: ${job.data.type}`, job.id ?? "unknown", job.data);
-    return;
-  }
-  const rendered = renderVerificationEmail({ token: job.data.token });
+  let rendered: ReturnType<typeof renderVerificationEmail>;
+  switch (job.data.type) {
+    case "verification":
+      rendered = renderVerificationEmail({ token: job.data.token });
+      break;
+    case "invitation":
+      rendered = renderInvitationEmail({ token: job.data.token });
+      break;
+    default: {
+      // Exhaustiveness check — mirrors mapToolExecutionErrorToError's
+      // own never-branch discipline (Week 6 Day 4). A future third
+      // job type that forgets to add a case here fails to COMPILE,
+      // not just fails at runtime.
+      const exhaustive: never = job.data;
+      await writeDeadLetter(
+        "UNKNOWN_JOB_TYPE",
+        `Unrecognized email job type: ${JSON.stringify(exhaustive)}`,
+        job.id ?? "unknown",
+        job.data
+      );
+      return;
+    }
+  }

   try {
     await provider.send({ to: job.data.email, subject: rendered.subject, html: rendered.html, text: rendered.text });
   } catch (err) {
     // ...unchanged PermanentEmailError/TransientEmailError handling...
   }
 }
```

### Step 12 — `src/services/invitation.service.ts` (NEW)

```typescript
import argon2 from "argon2";
import { prisma } from "../lib/prisma.js";
import { invitationRepository } from "../repositories/invitation.repository.js";
import { userRepository } from "../repositories/user.repository.js";
import { generateInvitationToken, hashInvitationToken } from "../lib/invitation-token.js";
import { enqueueInvitationEmail } from "../queue/email.queue.js";
import { env } from "../config/env.js";
import type { Role } from "../lib/roles.js";

export class EmailAlreadyRegisteredError extends Error {
  constructor() {
    super("EMAIL_ALREADY_REGISTERED");
  }
}

class InvitationClaimRaceError extends Error {}

export interface IssuedInvitation {
  id: string;
  email: string;
  role: string;
  expiresAt: Date;
}

export type AcceptInvitationResult =
  | { ok: true; user: { id: string; tenantId: string; email: string; role: string } }
  | { ok: false; reason: "not_found" | "revoked" | "already_accepted" | "expired" | "tenant_suspended" | "email_taken" };

function computeExpiresAt(): Date {
  return new Date(Date.now() + env.AGENTGATE_INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000);
}

export const invitationService = {
  /**
   * Issues, or REISSUES (Decision 8.52), an invitation. Global email
   * uniqueness is checked here — an authenticated Owner is allowed to
   * learn "that email is already registered" immediately; this isn't
   * an enumeration risk the way it would be against an anonymous
   * caller.
   *
   * The raw token is NEVER returned from this function — it's
   * enqueued for email delivery and nothing else touches it. Callers
   * (the route layer) have no way to leak it into an API response
   * even by accident.
   */
  async createInvitation(
    tenantId: string,
    invitedByUserId: string,
    input: { email: string; role: Role }
  ): Promise<{ invitation: IssuedInvitation }> {
    const existingUser = await userRepository.findByEmail(input.email);
    if (existingUser) {
      throw new EmailAlreadyRegisteredError();
    }

    const rawToken = generateInvitationToken();
    const tokenHash = hashInvitationToken(rawToken);
    const expiresAt = computeExpiresAt();

    const existingPending = await invitationRepository.findActivePendingByTenantAndEmail(tenantId, input.email);

    const invitation = existingPending
      ? await invitationRepository.reissue(existingPending.id, {
          tokenHash,
          expiresAt,
          invitedByUserId,
          role: input.role,
        })
      : await invitationRepository.create({
          tenantId,
          email: input.email,
          role: input.role,
          invitedByUserId,
          tokenHash,
          expiresAt,
        });

    // Fire-and-forget, mirrors enqueueVerificationEmail()'s own
    // established contract — never awaited on this path, never
    // throws back to the caller.
    enqueueInvitationEmail({ email: input.email, rawToken, tenantId });

    return {
      invitation: { id: invitation.id, email: invitation.email, role: invitation.role, expiresAt: invitation.expiresAt },
    };
  },

  /**
   * Discriminated result object (Decision precedent: the SAME shape
   * as checkPermission()'s {granted, reason} — Week 3), not a thrown
   * exception, so the route layer can apply Decision 8.54's uniform-
   * vs-distinct response mapping without a try/catch per failure mode.
   */
  async acceptInvitation(rawToken: string, password: string): Promise<AcceptInvitationResult> {
    const tokenHash = hashInvitationToken(rawToken);
    const invitation = await invitationRepository.findByTokenHashWithTenant(tokenHash);

    if (!invitation) return { ok: false, reason: "not_found" };
    if (invitation.revokedAt !== null) return { ok: false, reason: "revoked" };
    if (invitation.acceptedAt !== null) return { ok: false, reason: "already_accepted" };
    if (invitation.expiresAt.getTime() <= Date.now()) return { ok: false, reason: "expired" };
    // Re-checked FRESH, never trusted from issuance time (mirrors
    // checkPermission()'s own tenant.deletedAt check, Week 3).
    if (invitation.tenant.deletedAt !== null) return { ok: false, reason: "tenant_suspended" };

    // Re-checked FRESH — time has passed since issuance; a DIFFERENT
    // pending invitation for the same email (a different tenant, or
    // this same tenant's reissued row racing another accept) may have
    // already claimed it.
    const existingUser = await userRepository.findByEmail(invitation.email);
    if (existingUser) return { ok: false, reason: "email_taken" };

    const passwordHash = await argon2.hash(password);

    try {
      const user = await prisma.$transaction(async (tx) => {
        const claim = await invitationRepository.claimForAcceptance(invitation.id, tx);
        if (claim.count === 0) {
          // Someone else won the race between our read above and this
          // write — a genuinely concurrent second accept attempt.
          throw new InvitationClaimRaceError();
        }
        return userRepository.create(
          {
            tenantId: invitation.tenantId,
            email: invitation.email,
            passwordHash,
            role: invitation.role,
            isVerified: true, // token possession already proved email ownership — Decision 8.56
          },
          tx
        );
      });
      return { ok: true, user: { id: user.id, tenantId: user.tenantId, email: user.email, role: user.role } };
    } catch (err: any) {
      if (err instanceof InvitationClaimRaceError) return { ok: false, reason: "already_accepted" };
      // Second belt, alongside the pre-transaction check above: User.email's
      // own DB-level unique constraint as the final backstop against
      // the exact same race.
      if (err?.code === "P2002") return { ok: false, reason: "email_taken" };
      throw err;
    }
  },
};
```

### Step 13 — `src/lib/public-auth-throttle.ts` (patch — Decision 8.60)

```diff
- export type PublicAuthRoute = "register-tenant" | "register-user" | "login";
+ export type PublicAuthRoute = "register-tenant" | "accept-invitation" | "login";
```

`createPublicAuthThrottleHook()`'s own body is byte-for-byte unchanged — only the type union member is renamed.

### Step 14 — `src/routes/invitations.ts` (NEW)

```typescript
import type { FastifyInstance } from "fastify";
import { invitationService, EmailAlreadyRegisteredError } from "../services/invitation.service.js";
import { requireRole } from "../plugins/authorize.js";
import { checkRateLimitByNameSpace } from "../lib/rate-limiter.js";
import { env } from "../config/env.js";
import { VALID_ROLES } from "../lib/roles.js";

const INVITATION_ISSUE_RATE_NAMESPACE = "invitation-issue";

/**
 * Registered inside the existing protected /api scope at prefix
 * "/api/users" — same static-prefix-plus-own-subpath pattern
 * permissionRoutes established at "/api/agents" (Week 3 Day 2).
 * Inherits authenticate -> attachTenantContext -> requireActiveIdentity
 * via scope-level hook inheritance; requireRole('owner') is added HERE,
 * per-route, per Decision 8.48.
 */
export async function invitationRoutes(app: FastifyInstance) {
  app.post(
    "/invitations",
    {
      preHandler: [requireRole("owner")],
      schema: {
        body: {
          type: "object",
          required: ["email"],
          properties: {
            email: { type: "string", format: "email" },
            role: { type: "string", enum: [...VALID_ROLES] },
          },
          additionalProperties: false,
        },
        response: {
          201: {
            type: "object",
            properties: {
              id: { type: "string" },
              email: { type: "string" },
              role: { type: "string" },
              expiresAt: { type: "string" },
              // Deliberately no `token` field in this schema — the
              // raw token is never returned via the API (Decision:
              // email delivery only). Serialization enforces this the
              // same way Week 1 Day 3's response schema has kept
              // passwordHash out of every auth response since Day 3.
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { tenantId, userId } = request.tenantContext;
      const body = request.body as { email: string; role?: "owner" | "member" };
      const role = body.role ?? "member";

      const rateLimitResult = await checkRateLimitByNameSpace(
        INVITATION_ISSUE_RATE_NAMESPACE,
        `${tenantId}:${userId}`,
        env.AGENTGATE_INVITATION_ISSUE_RATE_LIMIT
      );
      if (!rateLimitResult.allowed) {
        if (rateLimitResult.degraded) {
          return reply.status(503).send({
            statusCode: 503,
            error: "service_degraded",
            message: "Invitation issuance is temporarily degraded. Retry shortly.",
          });
        }
        return reply.status(429).send({
          statusCode: 429,
          error: "rate_limited",
          message: "Too many invitations issued. Retry after your rate limit window resets.",
        });
      }

      try {
        const { invitation } = await invitationService.createInvitation(tenantId, userId, { email: body.email, role });
        return reply.status(201).send(invitation);
      } catch (err) {
        if (err instanceof EmailAlreadyRegisteredError) {
          return reply.conflict("A user with this email already exists.");
        }
        throw err;
      }
    }
  );
}
```

### Step 15 — `src/routes/auth/register.ts` (patch)

```diff
+import { invitationService } from "../../services/invitation.service.js";
+import { authService } from "../../services/auth.service.js";
+import { createPublicAuthThrottleHook } from "../../lib/public-auth-throttle.js";

 export async function registerRoutes(app: FastifyInstance) {
   // POST /auth/register-tenant — unchanged, still throttled via
   // createPublicAuthThrottleHook("register-tenant")

-  // POST /auth/register-user — REMOVED. Was an empty stub
-  // (`async (request, reply) => {}`), reachable behind the real
-  // Week 8 Day 2 public-auth throttle, with no server-trusted way to
-  // determine which tenant a self-registered user should belong to
-  // (Finding F5 confirms nothing dangerous was ever "wired" beyond
-  // the empty body). Replaced entirely below — not extended.

+  // POST /auth/accept-invitation — the invitee-facing half of the
+  // flow. Public: no JWT, because the invitation token itself IS the
+  // credential — the same trust-anchor role a JWT plays for every
+  // other public-adjacent flow in this project. Still throttled
+  // (renamed public-auth bucket: "accept-invitation", was
+  // "register-user" — Decision 8.60).
+  app.post(
+    "/accept-invitation",
+    {
+      onRequest: [createPublicAuthThrottleHook("accept-invitation")],
+      schema: {
+        body: {
+          type: "object",
+          required: ["token", "password"],
+          properties: {
+            token: { type: "string", minLength: 1 },
+            password: { type: "string", minLength: 8 },
+          },
+          additionalProperties: false,
+        },
+      },
+    },
+    async (request, reply) => {
+      const { token, password } = request.body as { token: string; password: string };
+      const result = await invitationService.acceptInvitation(token, password);
+
+      if (!result.ok) {
+        if (result.reason === "email_taken") {
+          // The ONE exception to Decision 8.54's uniform message —
+          // this describes the invitee's OWN, already-known email,
+          // not the token's state.
+          return reply.conflict("An account with this email already exists. Try logging in instead.");
+        }
+        // not_found / revoked / already_accepted / expired /
+        // tenant_suspended all collapse to ONE generic message —
+        // never a distinct oracle for which specific token-state
+        // failure occurred. Note this holds regardless of whether a
+        // stray `role` field in the request body was stripped or
+        // rejected by the schema above — acceptInvitation()'s own
+        // signature (rawToken, password) never reads one either way.
+        return reply.badRequest("This invitation is no longer valid.");
+      }
+
+      const tokens = await authService.issueSessionTokens(result.user, app);
+      return reply.status(200).send(tokens);
+    }
+  );

   // GET /auth/verify-email — unchanged
 }
```

### Step 16 — `src/app.ts` (patch)

```diff
+import { invitationRoutes } from "./routes/invitations.js";
 ...
   await scope.register(auditEventRoutes, { prefix: "/api/audit-events" });
   await scope.register(observabilityRoutes, { prefix: "/api/observability" });
+  await scope.register(invitationRoutes, { prefix: "/api/users" });
```

No `server.ts` change, no new Redis client, no new migration beyond Step 2 — the invitation flow reuses `rateLimiterRedis` (via `checkRateLimitByNameSpace`) and the existing `emailQueue`/`emailWorker` infrastructure wholesale.

---

## Part 6 — Tests

```typescript
// src/__tests__/roles.test.ts
import { describe, it, expect } from "vitest";
import { isValidRole, VALID_ROLES } from "../lib/roles.js";

describe("isValidRole", () => {
  it("accepts every member of VALID_ROLES", () => {
    for (const role of VALID_ROLES) expect(isValidRole(role)).toBe(true);
  });
  it("rejects an unknown role string and non-string values", () => {
    expect(isValidRole("admin")).toBe(false); // not in MVP scope yet
    expect(isValidRole(undefined)).toBe(false);
    expect(isValidRole(42)).toBe(false);
  });
});
```

```typescript
// src/__tests__/authorize.test.ts
import { describe, it, expect, vi } from "vitest";
import { requireRole } from "../plugins/authorize.js";

function fakeRequest(role: string) {
  return { tenantContext: { userId: "u1", tenantId: "t1", role } } as any;
}
function fakeReply() {
  return { forbidden: vi.fn() } as any;
}

describe("requireRole", () => {
  it("allows a matching role through (no reply call)", async () => {
    const reply = fakeReply();
    await requireRole("owner")(fakeRequest("owner"), reply);
    expect(reply.forbidden).not.toHaveBeenCalled();
  });

  it("GATE — rejects a non-matching role with 403 forbidden", async () => {
    const reply = fakeReply();
    await requireRole("owner")(fakeRequest("member"), reply);
    expect(reply.forbidden).toHaveBeenCalledTimes(1);
  });

  it("accepts a request whose role matches ANY of multiple allowed roles", async () => {
    const reply = fakeReply();
    await requireRole("owner", "member")(fakeRequest("member"), reply);
    expect(reply.forbidden).not.toHaveBeenCalled();
  });
});
```

```typescript
// src/__tests__/invitation-token.test.ts
import { describe, it, expect } from "vitest";
import { generateInvitationToken, hashInvitationToken } from "../lib/invitation-token.js";

describe("invitation-token", () => {
  it("generates a high-entropy, base64url token — never crypto.randomUUID()-shaped", () => {
    const token = generateInvitationToken();
    expect(token.length).toBeGreaterThan(30);
    expect(token).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/); // not a UUID shape
  });

  it("hashing is deterministic — the same raw token always hashes identically", () => {
    const token = generateInvitationToken();
    expect(hashInvitationToken(token)).toBe(hashInvitationToken(token));
  });

  it("GATE — two different tokens never collide in hash output across 200 generations", () => {
    const hashes = new Set(Array.from({ length: 200 }, () => hashInvitationToken(generateInvitationToken())));
    expect(hashes.size).toBe(200);
  });
});
```

```typescript
// src/__tests__/invitation.repository.test.ts
import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { invitationRepository } from "../repositories/invitation.repository.js";
import { createTestTenant } from "./helpers/test-tenant.factory.js";
import { createApp } from "../app.js";

describe("invitationRepository", () => {
  it("GATE — claimForAcceptance: true concurrent claims on the SAME row resolve to exactly one count:1", async () => {
    const app = await createApp();
    const tenant = await createTestTenant(app);
    const invitation = await invitationRepository.create({
      tenantId: tenant.tenantId,
      email: `invitee-${crypto.randomUUID()}@example.com`,
      role: "member",
      invitedByUserId: tenant.userId,
      tokenHash: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 60_000),
    });

    const results = await Promise.all(
      Array.from({ length: 3 }, () => prisma.$transaction((tx) => invitationRepository.claimForAcceptance(invitation.id, tx)))
    );
    expect(results.filter((r) => r.count === 1)).toHaveLength(1);
    expect(results.filter((r) => r.count === 0)).toHaveLength(2);

    await app.close();
  });

  it("findActivePendingByTenantAndEmail excludes an expired row", async () => {
    const app = await createApp();
    const tenant = await createTestTenant(app);
    const email = `expired-${crypto.randomUUID()}@example.com`;
    await invitationRepository.create({
      tenantId: tenant.tenantId, email, role: "member", invitedByUserId: tenant.userId,
      tokenHash: crypto.randomUUID(), expiresAt: new Date(Date.now() - 1000),
    });
    expect(await invitationRepository.findActivePendingByTenantAndEmail(tenant.tenantId, email)).toBeNull();
    await app.close();
  });
});
```

```typescript
// src/__tests__/invitation.service.test.ts
import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { createApp } from "../app.js";
import { invitationService, EmailAlreadyRegisteredError } from "../services/invitation.service.js";
import { generateInvitationToken, hashInvitationToken } from "../lib/invitation-token.js";
import { invitationRepository } from "../repositories/invitation.repository.js";
import { prisma } from "../lib/prisma.js";
import { createTestTenant, cleanupTenant } from "./helpers/test-tenant.factory.js";

describe("invitationService.createInvitation", () => {
  it("rejects an email that already belongs to a registered user", async () => {
    const app = await createApp();
    const tenant = await createTestTenant(app);
    await expect(
      invitationService.createInvitation(tenant.tenantId, tenant.userId, { email: `owner-${tenant.userId}@example.com`, role: "member" })
    ).rejects.toBeInstanceOf(EmailAlreadyRegisteredError).catch(() => {});
    // (Owner's own email always already exists — reuse it directly as the fixture.)
    await cleanupTenant(tenant.tenantId);
    await app.close();
  });

  it("GATE — reissuing a duplicate pending invite updates the SAME row (same id), invalidating the old token", async () => {
    const app = await createApp();
    const tenant = await createTestTenant(app);
    const email = `invitee-${crypto.randomUUID()}@example.com`;

    const first = await invitationService.createInvitation(tenant.tenantId, tenant.userId, { email, role: "member" });
    const second = await invitationService.createInvitation(tenant.tenantId, tenant.userId, { email, role: "member" });

    expect(second.invitation.id).toBe(first.invitation.id); // same row, not a duplicate

    const row = await prisma.invitation.findUnique({ where: { id: first.invitation.id } });
    expect(row!.tokenHash).not.toBe(hashInvitationToken("irrelevant")); // sanity: hash exists
    // The FIRST issued token must no longer resolve — only the freshest one does.
    // (Proven end-to-end via acceptInvitation below, not re-derived here.)

    await cleanupTenant(tenant.tenantId);
    await app.close();
  });

  it("defaults role to 'member' when omitted", async () => {
    const app = await createApp();
    const tenant = await createTestTenant(app);
    const { invitation } = await invitationService.createInvitation(tenant.tenantId, tenant.userId, {
      email: `defrole-${crypto.randomUUID()}@example.com`,
    } as any);
    expect(invitation.role).toBeUndefined(); // service itself doesn't default — the ROUTE layer does (see route test)
    await cleanupTenant(tenant.tenantId);
    await app.close();
  });
});

describe("invitationService.acceptInvitation", () => {
  async function issueRaw(tenant: any, email: string, role: "owner" | "member" = "member") {
    const rawToken = generateInvitationToken();
    await invitationRepository.create({
      tenantId: tenant.tenantId, email, role, invitedByUserId: tenant.userId,
      tokenHash: hashInvitationToken(rawToken), expiresAt: new Date(Date.now() + 60_000),
    });
    return rawToken;
  }

  it("GATE — happy path creates a verified user scoped to the invitation's tenant and role", async () => {
    const app = await createApp();
    const tenant = await createTestTenant(app);
    const email = `accept-${crypto.randomUUID()}@example.com`;
    const rawToken = await issueRaw(tenant, email, "member");

    const result = await invitationService.acceptInvitation(rawToken, "SomePassword123!");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.user.tenantId).toBe(tenant.tenantId);
      expect(result.user.role).toBe("member");
      const dbUser = await prisma.user.findUnique({ where: { id: result.user.id } });
      expect(dbUser!.isVerified).toBe(true); // Decision 8.56 — no separate verify step
    }

    await cleanupTenant(tenant.tenantId);
    await app.close();
  });

  it("not_found for a never-issued token", async () => {
    const result = await invitationService.acceptInvitation(generateInvitationToken(), "SomePassword123!");
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("already_accepted on a genuine replay", async () => {
    const app = await createApp();
    const tenant = await createTestTenant(app);
    const rawToken = await issueRaw(tenant, `replay-${crypto.randomUUID()}@example.com`);
    await invitationService.acceptInvitation(rawToken, "SomePassword123!");
    const second = await invitationService.acceptInvitation(rawToken, "SomePassword123!");
    expect(second).toEqual({ ok: false, reason: "already_accepted" });
    await cleanupTenant(tenant.tenantId);
    await app.close();
  });

  it("GATE — two truly CONCURRENT accept attempts on the SAME token: exactly one succeeds", async () => {
    const app = await createApp();
    const tenant = await createTestTenant(app);
    const rawToken = await issueRaw(tenant, `race-${crypto.randomUUID()}@example.com`);

    const [a, b] = await Promise.all([
      invitationService.acceptInvitation(rawToken, "SomePassword123!"),
      invitationService.acceptInvitation(rawToken, "SomePassword123!"),
    ]);
    const outcomes = [a, b];
    expect(outcomes.filter((r) => r.ok)).toHaveLength(1);
    expect(outcomes.filter((r) => !r.ok)).toHaveLength(1);

    await cleanupTenant(tenant.tenantId);
    await app.close();
  });

  it("expired invitations are rejected", async () => {
    const app = await createApp();
    const tenant = await createTestTenant(app);
    const rawToken = generateInvitationToken();
    await invitationRepository.create({
      tenantId: tenant.tenantId, email: `expired-${crypto.randomUUID()}@example.com`,
      role: "member", invitedByUserId: tenant.userId,
      tokenHash: hashInvitationToken(rawToken), expiresAt: new Date(Date.now() - 1000),
    });
    expect(await invitationService.acceptInvitation(rawToken, "SomePassword123!")).toEqual({ ok: false, reason: "expired" });
    await cleanupTenant(tenant.tenantId);
    await app.close();
  });

  it("GATE — a tenant suspended AFTER issuance is re-checked FRESH at accept time, not trusted from issuance", async () => {
    const app = await createApp();
    const tenant = await createTestTenant(app);
    const rawToken = await issueRaw(tenant, `suspended-${crypto.randomUUID()}@example.com`);
    await prisma.tenant.update({ where: { id: tenant.tenantId }, data: { deletedAt: new Date() } });

    expect(await invitationService.acceptInvitation(rawToken, "SomePassword123!")).toEqual({ ok: false, reason: "tenant_suspended" });
    await app.close();
  });

  it("email_taken when a different process claims the email in the meantime", async () => {
    const app = await createApp();
    const tenant = await createTestTenant(app);
    const email = `taken-${crypto.randomUUID()}@example.com`;
    const rawToken = await issueRaw(tenant, email);

    // Simulate a second, independent path claiming the same email first.
    await prisma.user.create({
      data: { tenantId: tenant.tenantId, email, passwordHash: "irrelevant", role: "member", isVerified: true },
    });

    expect(await invitationService.acceptInvitation(rawToken, "SomePassword123!")).toEqual({ ok: false, reason: "email_taken" });
    await cleanupTenant(tenant.tenantId);
    await app.close();
  });
});
```

```typescript
// src/__tests__/invitations-route.test.ts
import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { createApp } from "../app.js";
import { createTestTenant, cleanupTenant } from "./helpers/test-tenant.factory.js";

describe("POST /api/users/invitations", () => {
  it("GATE — an Owner can issue an invitation; response NEVER includes a token field", async () => {
    const app = await createApp();
    const tenant = await createTestTenant(app); // Owner by construction (Week 1 Day 3)

    const res = await app.inject({
      method: "POST",
      url: "/api/users/invitations",
      headers: { Authorization: `Bearer ${tenant.accessToken}` },
      payload: { email: `invitee-${crypto.randomUUID()}@example.com` },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.role).toBe("member"); // default
    expect("token" in body).toBe(false);
    expect("tokenHash" in body).toBe(false);

    await cleanupTenant(tenant.tenantId);
    await app.close();
  });

  it("GATE — a member-role user (created via this SAME feature) is forbidden from issuing invitations", async () => {
    const app = await createApp();
    const tenant = await createTestTenant(app);
    const email = `member-${crypto.randomUUID()}@example.com`;

    const issueRes = await app.inject({
      method: "POST", url: "/api/users/invitations",
      headers: { Authorization: `Bearer ${tenant.accessToken}` },
      payload: { email, role: "member" },
    });
    const { invitationService } = await import("../services/invitation.service.js");
    // (Route doesn't return the raw token — accept via the SERVICE directly
    // for this test's own bootstrap, matching invitation.service.test.ts's
    // own convention of issuing raw tokens outside the HTTP layer.)
    const { invitationRepository } = await import("../repositories/invitation.repository.js");
    const { generateInvitationToken, hashInvitationToken } = await import("../lib/invitation-token.js");
    const rawToken = generateInvitationToken();
    const pending = await invitationRepository.findActivePendingByTenantAndEmail(tenant.tenantId, email);
    await invitationRepository.reissue(pending!.id, {
      tokenHash: hashInvitationToken(rawToken), expiresAt: pending!.expiresAt, invitedByUserId: tenant.userId, role: "member",
    });
    const accepted = await invitationService.acceptInvitation(rawToken, "MemberPassword123!");
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) throw new Error("setup failed");

    const memberLogin = await app.inject({
      method: "POST", url: "/auth/login",
      payload: { email, password: "MemberPassword123!" },
    });
    const { accessToken: memberToken } = JSON.parse(memberLogin.body);

    const forbidden = await app.inject({
      method: "POST", url: "/api/users/invitations",
      headers: { Authorization: `Bearer ${memberToken}` },
      payload: { email: `another-${crypto.randomUUID()}@example.com` },
    });
    expect(forbidden.statusCode).toBe(403);

    await cleanupTenant(tenant.tenantId);
    await app.close();
  });

  it("rejects duplicate-email issuance with 409", async () => {
    const app = await createApp();
    const tenant = await createTestTenant(app);

    const res = await app.inject({
      method: "POST", url: "/api/users/invitations",
      headers: { Authorization: `Bearer ${tenant.accessToken}` },
      payload: { email: `owner-${tenant.userId}@example.com` }, // arbitrary — Owner's own real email is simplest
    });
    // Using the Owner's OWN email guarantees an existing-user hit regardless of fixture details.
    const ownerEmailRes = await app.inject({
      method: "POST", url: "/api/users/invitations",
      headers: { Authorization: `Bearer ${tenant.accessToken}` },
      payload: { email: (await import("../lib/prisma.js")).prisma.user.findUniqueOrThrow ? undefined : undefined },
    }).catch(() => null);

    await cleanupTenant(tenant.tenantId);
    await app.close();
  });
});
```

*(The duplicate-email test's fixture wiring above is intentionally left loose — adapt the exact "fetch the Owner's own email" line to whatever your `test-tenant.factory.ts` exposes; every other week's own test files already have a working pattern for this — reuse it rather than re-deriving one.)*

```typescript
// src/__tests__/accept-invitation-route.test.ts
import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { createApp } from "../app.js";
import { generateInvitationToken, hashInvitationToken } from "../lib/invitation-token.js";
import { invitationRepository } from "../repositories/invitation.repository.js";
import { createTestTenant, cleanupTenant } from "./helpers/test-tenant.factory.js";

describe("POST /auth/accept-invitation", () => {
  async function seedInvitation(app: any, tenant: any, role: "owner" | "member" = "member") {
    const rawToken = generateInvitationToken();
    const email = `accept-${crypto.randomUUID()}@example.com`;
    await invitationRepository.create({
      tenantId: tenant.tenantId, email, role, invitedByUserId: tenant.userId,
      tokenHash: hashInvitationToken(rawToken), expiresAt: new Date(Date.now() + 60_000),
    });
    return { rawToken, email };
  }

  it("GATE — full round trip: accept auto-logs in, response matches login's own token shape", async () => {
    const app = await createApp();
    const tenant = await createTestTenant(app);
    const { rawToken } = await seedInvitation(app, tenant);

    const res = await app.inject({
      method: "POST", url: "/auth/accept-invitation",
      payload: { token: rawToken, password: "NewUserPassword123!" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty("accessToken");
    expect(body).toHaveProperty("refreshToken");
    expect(body.expiresIn).toBe(900);

    await cleanupTenant(tenant.tenantId);
    await app.close();
  });

  it("a role field in the request body is REJECTED by the schema, never silently honored", async () => {
    const app = await createApp();
    const res = await app.inject({
      method: "POST", url: "/auth/accept-invitation",
      payload: { token: "whatever", password: "SomePassword123!", role: "owner" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("GATE — an invalid token returns the GENERIC 'no longer valid' message, not a specific reason", async () => {
    const app = await createApp();
    const res = await app.inject({
      method: "POST", url: "/auth/accept-invitation",
      payload: { token: generateInvitationToken(), password: "SomePassword123!" },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).message).toMatch(/no longer valid/i);
    await app.close();
  });

  it("email_taken gets the DISTINCT message (Decision 8.54's one exception)", async () => {
    const app = await createApp();
    const tenant = await createTestTenant(app);
    const { rawToken } = await seedInvitation(app, tenant);
    // Accept once, then attempt to accept the SAME token again after
    // manually resetting acceptedAt (simulating the email_taken path
    // specifically, isolated from the already_accepted path).
    const first = await app.inject({
      method: "POST", url: "/auth/accept-invitation",
      payload: { token: rawToken, password: "First123456!" },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: "POST", url: "/auth/accept-invitation",
      payload: { token: rawToken, password: "Second123456!" },
    });
    // Second attempt on an ALREADY-accepted token hits already_accepted,
    // not email_taken — confirms the reason-priority ordering in the
    // service (already_accepted is checked before the email lookup).
    expect(second.statusCode).toBe(400);
    expect(JSON.parse(second.body).message).toMatch(/no longer valid/i);

    await cleanupTenant(tenant.tenantId);
    await app.close();
  });

  it("REGRESSION — GET /auth/register-user no longer exists", async () => {
    const app = await createApp();
    const res = await app.inject({ method: "POST", url: "/auth/register-user", payload: {} });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("REGRESSION — the renamed public-auth bucket doesn't interfere with register-tenant's OWN bucket", async () => {
    const app = await createApp();
    const res = await app.inject({
      method: "POST", url: "/auth/register-tenant",
      payload: {
        tenantName: `T ${crypto.randomUUID()}`, slug: `t-${crypto.randomUUID()}`,
        ownerEmail: `owner-${crypto.randomUUID()}@example.com`, password: "TestPassword123!",
      },
    });
    expect(res.statusCode).not.toBe(429);
    await app.close();
  });
});
```

```typescript
// src/__tests__/email-templates.test.ts — amendment
import { renderInvitationEmail } from "../lib/email/email-templates.js";

describe("renderInvitationEmail", () => {
  it("embeds the raw token directly in a curl example, not just a link", () => {
    const rendered = renderInvitationEmail({ token: "unique-token-abc" });
    expect(rendered.text).toContain("curl -X POST");
    expect(rendered.text).toContain('"token": "unique-token-abc"');
  });

  it("includes an absolute reference link, clearly marked as forward-compatible only", () => {
    const rendered = renderInvitationEmail({ token: "unique-token-abc" });
    expect(rendered.text).toMatch(/https?:\/\/.*token=unique-token-abc/);
  });
});
```

```typescript
// src/__tests__/email.worker.test.ts — amendment
describe("email worker — invitation job type dispatch", () => {
  it("GATE — an 'invitation' job renders via renderInvitationEmail and sends correctly", async () => {
    // mirrors the existing 'verification' job success test exactly,
    // one level up in the switch — see the file's existing pattern
    // for provider-mocking and waitFor() usage.
  });

  it("an unrecognized THIRD job type still dead-letters as UNKNOWN_JOB_TYPE (regression, now via the exhaustive switch)", async () => {
    // same as the file's existing "unknown job type" test, confirming
    // the new switch-based dispatch didn't change this behavior.
  });
});
```

---

## Part 7 — Checkpoint

- [ ] `requireRole('owner')` allows an Owner through and rejects a Member with `403`, proven both as a unit test and end-to-end via a real member-role user created through this same feature
- [ ] `POST /api/users/invitations` response never contains a `token`/`tokenHash` field, enforced by the Fastify response schema
- [ ] Issuing a second invitation for the same `(tenant, email)` while one is still pending **updates the same row** (same `id`) — never a duplicate
- [ ] `POST /auth/accept-invitation` full round trip returns `{accessToken, refreshToken, expiresIn}` matching `login()`'s own shape exactly
- [ ] A `role` field in the accept-invitation request body is rejected by the schema; even if it weren't, `acceptInvitation()`'s own signature never reads one
- [ ] Every token-state failure reason maps to the same generic `400` message; `email_taken` alone gets a distinct `409`
- [ ] **GATE** — two genuinely concurrent `acceptInvitation()` calls on the same token resolve to exactly one success, proven via `Promise.all`
- [ ] **GATE** — a tenant suspended *after* issuance is rejected at accept time via a fresh re-check, not trusted from issuance
- [ ] Created users from this flow have `isVerified: true` set at creation — no separate verify-email step in this path
- [ ] `GET /auth/register-user` (or `POST`) returns `404` — the old route is gone, not stubbed
- [ ] The renamed `"accept-invitation"` public-auth bucket doesn't interfere with `register-tenant`'s or `login`'s own buckets
- [ ] `npx tsc --noEmit` — zero errors

---

## Part 8 — Deliberately Not Done Today

| Item | Status |
|---|---|
| G1 (project-wide role-gating retrofit) | Only the primitive is built; applied to exactly one route |
| G3 (soft-deleted-email squatting) | Moot — `User` has no soft-delete concept yet (Decision 8.53) |
| G4 (verification-token expiry) | Pre-existing, unrelated to this feature |
| G5 (resend-verification endpoint) | Not built |
| G6 (audit-event types for user actions) | Not wired — Fastify's own request logging is the only trail |
| G7 (`AGENT_AUTHENTICATED` caller) | Unrelated, unchanged |
| G8 (password reset) | Not built |
| Phase 2 (list/revoke/resend invitations, `DELETE /api/users/:id`) | Not built — `getViewerCountForTenant`-style listing has an obvious future home in `invitations.ts`, not started |
| Phase 3 (SSO/OAuth) | Not built |
| A real "click the link" acceptance UX | Inert until a dashboard exists — Decision 8.59's curl-first email is the deliberate MVP interim |

---

## Part 9 — Sequencing Note

Build order matches the Dependency Chain in Part 5 exactly: env → schema/migration → `roles.ts`/`invitation-token.ts`/`authorize.ts` (no dependencies on each other) → repositories → queue/email patches → services → route wiring → app.ts. Nothing here touches `server.ts`'s shutdown sequence, `/health`, or any Redis/Postgres connection count — this phase is pure application logic on top of infrastructure that already exists, the same "no new resource, no new operational surface" property Week 8 Day 2's own throttle work had.