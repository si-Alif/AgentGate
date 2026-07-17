# AgentGate — Week 3 Roadmap (Revised)
## Permission Enforcement, Redis Rate Limiting & Hybrid Circuit Breaker (Milestone 3)

**Format:** Same as `roadmap_w2.md` — JIT learning block → build block → daily checkpoint, every build block containing working code.
**Status:** This supersedes the earlier Week 3 draft. Seven amendments from the architecture review are folded directly into the day-by-day content below, rather than tracked as a separate patch — the table immediately below tells you exactly what changed and why, so you don't have to diff two documents by hand.

---

## What Changed From the Earlier Draft

| # | Where | What changed | Why |
|---|---|---|---|
| 1 | Day 3 | Rate limiter now uses a **dedicated ioredis client** (`rate-limit-redis.ts`), not the shared `redis.ts` singleton | The draft's `maxRetriesPerRequest: 1` on the shared client directly conflicts with BullMQ's hard requirement of `maxRetriesPerRequest: null` on that same client (see `redis.ts`'s own existing comment). Implemented as originally drafted, this would have broken the Week 1 email queue and Week 5's audit worker. |
| 2 | Day 1 + Day 2 | `checkPermission()`'s context query now also checks `tenant.deletedAt` | Closes the same class of mid-session-revocation gap Day 2 already targeted for agents/tools — but for tenant suspension. Nothing else on the agent-authenticated (API key) path re-verifies this; the JWT-side soft-delete hook only guards the human-user REST scope. |
| 3 | Day 1 | Added the missing `Tenant.agentToolPermissions` back-reference field to the Prisma schema | Prisma requires both sides of a relation to be declared. The earlier draft added `Agent.permissions` and `Tool.permissions` but missed the equivalent field on `Tenant` — as written, that schema would fail `prisma generate`. |
| 4 | Day 5 | Two breaker behaviors are now documented precisely instead of loosely | The fail-open window is bounded by *time* (~1 `commandTimeout` cycle), not by an exact call count; concurrent `HALF_OPEN` probes have a last-write-wins race, not just "a couple of extra Redis attempts." Both are still accepted tradeoffs — just accurately described in the code comments so nobody assumes a stronger guarantee. |
| 5 | Day 2 | Added a `checkPermission()` latency bench, mirroring Day 4's existing rate-limiter bench | By Week 6, this and `checkRateLimit()` both sit in front of every `executeTool()` call, inside a shared 300ms p95 gateway-overhead budget. Measure it now — same discipline as everywhere else in this project. |
| 6 | Day 7 | `prisma.ts`'s open `// TODO: define max connection pool size` gets a concrete, working answer | Week 3 adds the first hot-path DB read (`checkPermission`) that will run on every future tool call. Better to decide this deliberately than discover a starved pool during the Week 6/8 concurrency tests. |
| 7 | Day 7 / PROGRESS.md | Re-running the rate-limit latency bench against real deployed Redis is now an explicit Week 8 checklist line, not just a caveat in prose | Local-Redis numbers don't transfer to a networked managed instance — this makes sure it doesn't quietly get skipped once Week 8 is a scramble to ship. |

Everything else from the original draft — the dedicated-week structure, the `{granted, reason}` result shape, the hybrid circuit breaker concept, the Lua-does-atomic-INCR-only split, the Phase-2 stub columns — was already correct and carries forward unchanged.

---

## Key Decisions & Deltas

| # | Decision | Why | Lands in |
|---|---|---|---|
| 1 | M3 built as its own dedicated week; M4 (Tool Execution Pipeline) fully deferred to Week 4 | Both are trust-boundary, adversarial-mindset modules — HLD's own words call M4 "the most dangerous module in the system." Context-switching between two of these in one week is exactly the condition under which one gets shortchanged. Same total 2-week span either way. | Structural |
| 2 | `checkPermission()` returns a `PermissionCheckResult` object (`granted` + `reason`), not a plain `Promise<boolean>` | A boolean can't distinguish "we evaluated policy and denied you" (→ `-32000`, built in M6) from "we couldn't evaluate policy at all" (→ `-32603`, built in M6). Costs nothing extra. | Day 2 |
| 3 | `checkPermission()`'s query verifies `agent.isActive`, `tool.isActive`, **and `tenant.deletedAt`** | Closes the mid-session-deactivation gap on all three axes an agent's call depends on — not just the permission row's own flag. Deactivating an agent, a tool, *or suspending the whole tenant* should all immediately block the next `tools/call`, not wait for a session to idle-time-out. | Day 1 (query) / Day 2 (branch) |
| 4 | `agent_tool_permissions` includes the Phase-2 columns (`parameter_constraints`, `call_budget_per_hour`) now, unused by any Week 3 code path | PRD's own data model (§10) already lists them; adding them now avoids a migration later. Explicitly commented as inert everywhere they appear. | Day 1 |
| 5 | Rate limiter resilience is a **hybrid circuit breaker** (bounded fail-open below a failure threshold, fail-closed once tripped, probed back via `HALF_OPEN`) | Pure fail-closed turns one dropped connection into a full gateway outage. Pure fail-open turns a real Redis outage into zero DoS protection, indefinitely. State lives in-process — same limitation class as the Session Map (HLD §3.1), and correct for the same reason: centralizing breaker state in Redis is circular the moment Redis is the thing that's down. | Day 5 |
| 6 | The rate-limit `allowed` decision is computed in TypeScript (`evaluateRateLimit`), not inside the Lua script | Redis's `INCR` atomicity is what guarantees correctness under concurrency — the threshold comparison is safe to do anywhere afterward. Doing it in TS makes it a pure, directly unit-testable function with zero Redis mocking. | Day 4 |
| 7 | Fixed-window counter (not sliding-window/sorted-set) accepted as-is, with the boundary-burst behavior (up to ~2× the limit across a minute boundary) documented as a deliberate tradeoff | Matches HLD's explicit choice. Sliding-window accuracy isn't worth the added Redis complexity for an MVP gateway. | Day 3 |
| 8 | No extra composite index beyond `@@unique([agentId, toolId])` | `agentId` and `toolId` each already belong to exactly one tenant via their own FK chains, so the pair is already implicitly tenant-scoped. | Day 1 |
| 9 | Rate limiter gets its **own dedicated ioredis client**, separate from the shared BullMQ-serving client | `maxRetriesPerRequest: null` (BullMQ's hard requirement) and `maxRetriesPerRequest: 1` (the breaker's fast-fail requirement) cannot coexist on one client instance — confirmed directly against the existing `redis.ts` comment. | Day 3 |
| 10 | `checkPermission()` latency gets its own bench, same as `checkRateLimit()` already has | Two sequential round trips (Postgres + Redis) sit in front of every future `executeTool()` call, inside one 300ms p95 budget. | Day 2 |

---

## Week 3 Dependency Chain

```
Day 1 (Schema: agent_tool_permissions + repository)
  │
  │  Cross-tenant guard falls out of reusing Week 2's
  │  already-tenant-scoped agent/tool lookups. The context
  │  query also now pulls tenant.deletedAt so Day 2 can
  │  make the tenant-suspension check. Schema includes the
  │  Tenant-side back-reference the earlier draft missed.
  │
  ▼
Day 2 (checkPermission engine + assign/revoke/list service+routes)
  │
  │  Returns a result OBJECT with FIVE denial reasons
  │  (not_found, tenant_suspended, permission_inactive,
  │  agent_inactive, tool_inactive) + a latency bench.
  │
  ▼
Day 3 (DEDICATED rate-limit Redis client + Lua script,
        proven standalone)
  │
  │  A separate ioredis client from the one BullMQ uses —
  │  their retry/timeout requirements directly conflict.
  │  Atomicity proven before it's wrapped in application code.
  │
  ▼
Day 4 (checkRateLimit wrapper + concurrency proof + latency bench)
  │
  ▼
Day 5 (Hybrid circuit breaker, wired to the dedicated client)
  │
  ▼
Day 6 (Integration tests + FIVE-gate proof checkpoint + review)
  │
  ▼
Day 7 (Buffer + prisma.ts pool-size fix + PROGRESS.md + Week 4 preview)
```

---

## Day 1 — Schema Foundations: `agent_tool_permissions` & Repository

**Hours target:** 5h

### Concept Primer (read before coding, ~20 min)

**Why `AgentToolPermission` is a first-class model, not an implicit many-to-many.** Prisma supports two ways to model a many-to-many relationship: an *implicit* join (Prisma manages a hidden join table you never query directly) or an *explicit* join model (a real model with its own `id` and its own extra fields). The implicit form only works when the join carries no data beyond "these two things are linked." The moment you need extra fields on the relationship itself — `isActive` (revocable), `parameterConstraints`, `callBudgetPerHour`, timestamps — you need the explicit form. That's the whole reason `AgentToolPermission` gets its own `@id @default(uuid())` instead of a bare `@relation` shorthand.

**Stub columns, precisely.** `parameterConstraints` and `callBudgetPerHour` are added this week but touched by *zero* Week 3 logic. This is deliberate forward-compatibility, not scope creep — the risk with unused columns is a future reader assuming "column exists" means "column enforced." Delete the inert-comment block the day Phase 2 enforcement actually lands, not before.

**Every Prisma relation needs both sides declared.** This is easy to forget when you're focused on the model that "owns" the foreign key. `AgentToolPermission.tenant` references `Tenant` — so `Tenant` needs a matching array field (`agentToolPermissions AgentToolPermission[]`), the same way `Agent` and `Tool` each need their own `permissions AgentToolPermission[]`. Skip any one of these three and `prisma generate` fails with a relation-validation error, not a silent gap — but it's worth getting right the first time rather than discovering it mid-migration.

### Build Block

**Step 1 — Prisma schema addition (30 min)**

Add to `prisma/schema.prisma`, alongside your existing `Agent` and `Tool` models:

```prisma
model AgentToolPermission {
  id       String  @id @default(uuid())
  tenantId String  @map("tenant_id")
  agentId  String  @map("agent_id")
  toolId   String  @map("tool_id")
  isActive Boolean @default(true) @map("is_active")

  // ── Phase 2 stub columns ──────────────────────────────────────────
  // NOT read or enforced by ANY Week 3 code path. They exist now
  // purely to avoid a schema migration later (PRD §10 already lists
  // both on this table). Treat a non-null value here as INERT until
  // the Phase 2 authorization engine (PRD §8) is actually built.
  // Delete this comment block the day enforcement lands — not
  // before, or a future reader will assume these are already checked.
  parameterConstraints Json? @map("parameter_constraints")
  callBudgetPerHour    Int?  @map("call_budget_per_hour")

  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")

  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  agent  Agent  @relation(fields: [agentId], references: [id], onDelete: Cascade)
  tool   Tool   @relation(fields: [toolId], references: [id], onDelete: Cascade)

  // agentId and toolId each already belong to exactly one tenant via
  // their own FK chains — so this pair is already implicitly
  // tenant-scoped. A duplicate grant for the same (agent, tool) pair
  // is nonsensical regardless of tenantId, so tenantId doesn't need
  // to be part of the uniqueness constraint itself.
  @@unique([agentId, toolId])
  @@index([tenantId])
  @@map("agent_tool_permissions")
}
```

Add the back-references. **All three of these are required** — this is the one place the earlier draft was incomplete (it added the first two but missed `Tenant`'s):

```prisma
model Tenant {
  // ...existing fields...
  users                User[]
  agents               Agent[]
  tools                Tool[]
  agentToolPermissions AgentToolPermission[]   // ADD THIS LINE — required, not optional
}

model Agent {
  // ...existing fields...
  permissions AgentToolPermission[]
}

model Tool {
  // ...existing fields...
  permissions AgentToolPermission[]
}
```

Run the migration:

```bash
npx prisma migrate dev --name add_agent_tool_permissions
npx prisma generate
```

Open your DB inspector and confirm `agent_tool_permissions` exists with all nine columns before moving on. If you skip the `Tenant.agentToolPermissions` line above, `npx prisma generate` will fail immediately with a relation-validation error — that's expected and correct, not a bug in the schema.

**Step 2 — Repository (`src/repositories/permission.repository.ts`) (1h)**

```typescript
import { prisma } from "../lib/prisma.js";
import type { DbClient } from "../types/db-client.type.js"; // adjust if your exported name differs

export const permissionRepository = {
  create: (
    data: { tenantId: string; agentId: string; toolId: string },
    client: DbClient = prisma
  ) => client.agentToolPermission.create({ data }),

  listByAgent: (agentId: string, tenantId: string, client: DbClient = prisma) =>
    client.agentToolPermission.findMany({
      where: { agentId, tenantId },
      orderBy: { createdAt: "desc" },
    }),

  deactivate: (
    agentId: string,
    toolId: string,
    tenantId: string,
    client: DbClient = prisma
  ) =>
    client.agentToolPermission.updateMany({
      where: { agentId, toolId, tenantId },
      data: { isActive: false },
    }),

  /**
   * The hot-path lookup for checkPermission() (Day 2). Deliberately
   * fetches WITHOUT filtering on any isActive/deletedAt flag — the
   * engine needs to SEE an inactive row, an inactive agent/tool, OR
   * a suspended tenant to return a SPECIFIC denial reason, not just
   * a bare "not found." Filtering here would collapse all of those
   * into the same case.
   *
   * This also pulls `tenant.deletedAt`, on top of `agent.isActive`
   * and `tool.isActive`. Nothing else on the agent-authenticated
   * path (API key auth, not JWT) re-verifies that the tenant itself
   * hasn't been suspended — the JWT-side soft-delete hook
   * (attachTenantContext / requireActiveIdentity) only guards the
   * human-user REST scope, not the future agent-authenticated MCP
   * gateway (Week 6). Without this field, a suspended tenant's
   * agents would keep calling tools indefinitely, because nothing
   * else in the system currently cascades `isActive: false` onto
   * every agent/tool under a suspended tenant.
   */
  findGrantWithContext: (
    agentId: string,
    toolId: string,
    tenantId: string,
    client: DbClient = prisma
  ) =>
    client.agentToolPermission.findFirst({
      where: { agentId, toolId, tenantId },
      include: {
        agent: { select: { isActive: true } },
        tool: { select: { isActive: true } },
        tenant: { select: { deletedAt: true } },
      },
    }),
};
```

**Step 3 — Repository unit tests (`src/__tests__/permission.repository.test.ts`) (1h)**

```typescript
import { describe, it, expect } from "vitest";
import { permissionRepository } from "../repositories/permission.repository.js";
import {
  createTestTenant,
  createTestAgent,
  createTestTool,
  cleanupTenant,
} from "./helpers/test-tenant.factory.js";

describe("permissionRepository", () => {
  it("creates a permission grant scoped to a tenant", async () => {
    const tenant = await createTestTenant();
    const { agent } = await createTestAgent(tenant.id, tenant.ownerUserId);
    const tool = await createTestTool(tenant.id);

    const grant = await permissionRepository.create({
      tenantId: tenant.id,
      agentId: agent.id,
      toolId: tool.id,
    });

    expect(grant.isActive).toBe(true);
    expect(grant.parameterConstraints).toBeNull();
    expect(grant.callBudgetPerHour).toBeNull();

    await cleanupTenant(tenant.id);
  });

  it("rejects a duplicate (agentId, toolId) grant", async () => {
    const tenant = await createTestTenant();
    const { agent } = await createTestAgent(tenant.id, tenant.ownerUserId);
    const tool = await createTestTool(tenant.id);

    await permissionRepository.create({ tenantId: tenant.id, agentId: agent.id, toolId: tool.id });

    await expect(
      permissionRepository.create({ tenantId: tenant.id, agentId: agent.id, toolId: tool.id })
    ).rejects.toThrow(); // P2002 — the @@unique([agentId, toolId]) constraint

    await cleanupTenant(tenant.id);
  });

  it("findGrantWithContext returns the permission row's own isActive AND the agent/tool context", async () => {
    const tenant = await createTestTenant();
    const { agent } = await createTestAgent(tenant.id, tenant.ownerUserId);
    const tool = await createTestTool(tenant.id);
    await permissionRepository.create({ tenantId: tenant.id, agentId: agent.id, toolId: tool.id });

    const row = await permissionRepository.findGrantWithContext(agent.id, tool.id, tenant.id);

    expect(row).not.toBeNull();
    expect(row!.isActive).toBe(true);
    expect(row!.agent.isActive).toBe(true);
    expect(row!.tool.isActive).toBe(true);

    await cleanupTenant(tenant.id);
  });

  it("findGrantWithContext also returns the tenant's deletedAt status", async () => {
    const tenant = await createTestTenant();
    const { agent } = await createTestAgent(tenant.id, tenant.ownerUserId);
    const tool = await createTestTool(tenant.id);
    await permissionRepository.create({ tenantId: tenant.id, agentId: agent.id, toolId: tool.id });

    const row = await permissionRepository.findGrantWithContext(agent.id, tool.id, tenant.id);

    expect(row).not.toBeNull();
    expect(row!.tenant.deletedAt).toBeNull();

    await cleanupTenant(tenant.id);
  });

  it("findGrantWithContext returns null for a non-existent grant", async () => {
    const tenant = await createTestTenant();
    const { agent } = await createTestAgent(tenant.id, tenant.ownerUserId);
    const tool = await createTestTool(tenant.id);

    const row = await permissionRepository.findGrantWithContext(agent.id, tool.id, tenant.id);
    expect(row).toBeNull();

    await cleanupTenant(tenant.id);
  });
});
```

### ✅ Day 1 Checkpoint

- [ ] `agent_tool_permissions` table exists with all 9 columns (including the two nullable stub columns); `npx prisma studio` shows it
- [ ] `Tenant`, `Agent`, and `Tool` all have their back-reference fields for this relation — `npx prisma generate` completes with zero relation errors
- [ ] `@@unique([agentId, toolId])` constraint is live — a duplicate insert throws `P2002`
- [ ] `findGrantWithContext`'s `include` returns `agent.isActive`, `tool.isActive`, **and `tenant.deletedAt`**
- [ ] `npm test` passes the new `permission.repository.test.ts` suite
- [ ] `npx tsc --noEmit` — zero errors

---

## Day 2 — The Permission Engine: `checkPermission()` + Assign/Revoke/List

**Hours target:** 5h

### Concept Primer (~25 min)

**A result object, not a boolean.** We're returning `{ granted: true } | { granted: false, reason: ... }` rather than `Promise<boolean>`. When M6 (Week 6) eventually calls this inside the `tools/call` handler, it needs to pick between two *semantically different* JSON-RPC errors: `-32000 Permission Denied` (a policy decision) versus `-32603 Internal Error` (we couldn't evaluate the policy at all). A bare `false` can't carry that distinction, and collapsing them would make your audit log lie about what actually happened on a bad day.

**The join you don't expect, part one: `tools.isActive` and `agents.isActive`.** HLD 6.7's `tools/list` filters `tools.is_active = true` only when *listing* tools; the SSE handler only checks `agents.is_active` at *connect* time. Nothing re-checks either at `tools/call` time. An agent that already has a tool's ID from a prior `tools/list` — or obtained by any other means — could otherwise keep successfully invoking a deactivated tool for up to 5 minutes (the session idle timeout).

**The join you don't expect, part two: `tenant.deletedAt`.** The same argument applies one level up. If a whole tenant is suspended, every agent underneath it should stop working immediately — not "eventually, once something else cascades `isActive: false` onto every row." No such cascade exists anywhere in the current plan, and relying on one to hit every row correctly would just be a different, less legible way of getting this wrong. `AgentToolPermission` already has a direct `tenant` relation on the model (Day 1), so this is a one-field extension to a join you're already writing, not a new relation to define.

### Build Block

**Step 1 — Permission engine (`src/lib/permission-engine.ts`) (1h)**

```typescript
import { permissionRepository } from "../repositories/permission.repository.js";

export type PermissionCheckResult =
  | { granted: true }
  | {
      granted: false;
      reason:
        | "not_found"
        | "tenant_suspended"
        | "permission_inactive"
        | "agent_inactive"
        | "tool_inactive"
        | "error";
      error?: unknown;
    };

/**
 * The permission "engine" (HLD's own term). Pure from the caller's
 * perspective — no side effects, safe to call as often as needed,
 * independently unit-testable.
 *
 * Denial reasons are checked broadest-scope first: a suspended
 * tenant invalidates every agent and tool underneath it regardless
 * of their own individual isActive flags, so that check runs before
 * the permission/agent/tool-specific ones.
 */
export async function checkPermission(
  agentId: string,
  toolId: string,
  tenantId: string
): Promise<PermissionCheckResult> {
  try {
    const row = await permissionRepository.findGrantWithContext(agentId, toolId, tenantId);

    if (!row) return { granted: false, reason: "not_found" };

    if (row.tenant.deletedAt !== null) {
      return { granted: false, reason: "tenant_suspended" };
    }
    if (!row.isActive) return { granted: false, reason: "permission_inactive" };
    if (!row.agent.isActive) return { granted: false, reason: "agent_inactive" };
    if (!row.tool.isActive) return { granted: false, reason: "tool_inactive" };
    return { granted: true };
  } catch (err) {
    // Fail closed. An infrastructure fault must never be silently
    // treated as "granted." This is enforced INSIDE the engine
    // itself — correct by construction, before M6 even exists to
    // consume it.
    return { granted: false, reason: "error", error: err };
  }
}
```

**Step 2 — Permission service (`src/services/permission.service.ts`) (1h)**

```typescript
import { permissionRepository } from "../repositories/permission.repository.js";
import { agentRepository } from "../repositories/agent.repository.js";
import { toolRepository } from "../repositories/tool.repository.js";

export class PermissionValidationError extends Error {}

/**
 * Handles assignment/revocation/listing — the management-API side of
 * permissions. checkPermission() (permission-engine.ts) is the
 * separate, narrower "is this call allowed right now" question the
 * future gateway (M6) will call on every tools/call.
 */
export const permissionService = {
  async assignPermission(tenantId: string, input: { agentId: string; toolId: string }) {
    // Both lookups are ALREADY tenant-scoped — agentRepository.findById
    // and toolRepository.findById both filter by tenantId (Week 2's
    // established pattern). If either comes back null, the agent/tool
    // either doesn't exist OR belongs to a different tenant — the
    // cross-tenant guard falls out of correctly REUSING these existing
    // repositories, not from new logic written this week.
    const [agent, tool] = await Promise.all([
      agentRepository.findById(input.agentId, tenantId),
      toolRepository.findById(input.toolId, tenantId),
    ]);
    if (!agent || !tool) {
      throw new PermissionValidationError("AGENT_OR_TOOL_NOT_FOUND");
    }

    try {
      return await permissionRepository.create({
        tenantId,
        agentId: input.agentId,
        toolId: input.toolId,
      });
    } catch (err: any) {
      if (err.code === "P2002") {
        throw new Error("PERMISSION_ALREADY_EXISTS");
      }
      throw err;
    }
  },

  async listPermissions(tenantId: string, agentId: string) {
    return permissionRepository.listByAgent(agentId, tenantId);
  },

  async revokePermission(tenantId: string, agentId: string, toolId: string) {
    const { count } = await permissionRepository.deactivate(agentId, toolId, tenantId);
    return count > 0;
  },
};
```

**Step 3 — Routes (`src/routes/permissions.ts`) (45 min)**

```typescript
import type { FastifyInstance } from "fastify";
import { permissionService, PermissionValidationError } from "../services/permission.service.js";

/**
 * Registered in app.ts inside the SAME protected scope as agentRoutes,
 * with the SAME static prefix ("/api/agents") — these routes define
 * their own ":agentId/permissions" sub-path rather than relying on a
 * parametric register() prefix, so there's no ambiguity about how
 * Fastify resolves two plugins sharing one static prefix.
 */
export async function permissionRoutes(app: FastifyInstance) {
  app.post(
    "/:agentId/permissions",
    {
      schema: {
        body: {
          type: "object",
          required: ["toolId"],
          properties: { toolId: { type: "string" } },
        },
      },
    },
    async (request, reply) => {
      const { tenantId } = request.tenantContext;
      const { agentId } = request.params as { agentId: string };
      const { toolId } = request.body as { toolId: string };
      try {
        const permission = await permissionService.assignPermission(tenantId, { agentId, toolId });
        return reply.status(201).send(permission);
      } catch (err) {
        if (err instanceof PermissionValidationError) {
          return reply.notFound("Agent or tool not found in this tenant");
        }
        if (err instanceof Error && err.message === "PERMISSION_ALREADY_EXISTS") {
          return reply.conflict("This agent already has a permission grant for this tool");
        }
        throw err;
      }
    }
  );

  app.get("/:agentId/permissions", async (request) => {
    const { tenantId } = request.tenantContext;
    const { agentId } = request.params as { agentId: string };
    return permissionService.listPermissions(tenantId, agentId);
  });

  app.delete("/:agentId/permissions/:toolId", async (request, reply) => {
    const { tenantId } = request.tenantContext;
    const { agentId, toolId } = request.params as { agentId: string; toolId: string };
    const revoked = await permissionService.revokePermission(tenantId, agentId, toolId);
    if (!revoked) return reply.notFound();
    return reply.status(204).send();
  });
}
```

**Step 4 — Wire into `app.ts` (10 min)**

```typescript
import { permissionRoutes } from "./routes/permissions.js";

// ...inside the same protected scope as agentRoutes and toolRoutes:
await scope.register(agentRoutes, { prefix: "/api/agents" });
await scope.register(permissionRoutes, { prefix: "/api/agents" }); // same static prefix, different sub-paths
await scope.register(toolRoutes, { prefix: "/api/tools" }); // confirm this registration actually exists in your real app.ts
```

**Step 5 — Tests (`src/__tests__/permission-engine.test.ts` + `permission.service.test.ts`) (1.5h)**

```typescript
import { describe, it, expect, vi } from "vitest";
import { prisma } from "../lib/prisma.js";
import { checkPermission } from "../lib/permission-engine.js";
import { permissionRepository } from "../repositories/permission.repository.js";
import { permissionService } from "../services/permission.service.js";
import {
  createTestTenant,
  createTestAgent,
  createTestTool,
  cleanupTenant,
} from "./helpers/test-tenant.factory.js";

describe("checkPermission", () => {
  it("grants when the permission, agent, tool, and tenant are all active", async () => {
    const tenant = await createTestTenant();
    const { agent } = await createTestAgent(tenant.id, tenant.ownerUserId);
    const tool = await createTestTool(tenant.id);
    await permissionRepository.create({ tenantId: tenant.id, agentId: agent.id, toolId: tool.id });

    const result = await checkPermission(agent.id, tool.id, tenant.id);
    expect(result).toEqual({ granted: true });

    await cleanupTenant(tenant.id);
  });

  it("denies with reason 'not_found' when no grant exists", async () => {
    const tenant = await createTestTenant();
    const { agent } = await createTestAgent(tenant.id, tenant.ownerUserId);
    const tool = await createTestTool(tenant.id);

    const result = await checkPermission(agent.id, tool.id, tenant.id);
    expect(result).toEqual({ granted: false, reason: "not_found" });

    await cleanupTenant(tenant.id);
  });

  it("denies with reason 'tenant_suspended' when the tenant is soft-deleted mid-grant", async () => {
    const tenant = await createTestTenant();
    const { agent } = await createTestAgent(tenant.id, tenant.ownerUserId);
    const tool = await createTestTool(tenant.id);
    await permissionRepository.create({ tenantId: tenant.id, agentId: agent.id, toolId: tool.id });

    // No dedicated tenant-repository "suspend" method is assumed
    // here — swap for your actual tenant.repository.ts method if it
    // has one; a direct Prisma call is the safe fallback either way.
    await prisma.tenant.update({
      where: { id: tenant.id },
      data: { deletedAt: new Date() },
    });

    const result = await checkPermission(agent.id, tool.id, tenant.id);
    expect(result).toEqual({ granted: false, reason: "tenant_suspended" });

    await cleanupTenant(tenant.id);
  });

  it("denies with reason 'agent_inactive' when the agent is deactivated mid-grant", async () => {
    const tenant = await createTestTenant();
    const { agent } = await createTestAgent(tenant.id, tenant.ownerUserId);
    const tool = await createTestTool(tenant.id);
    await permissionRepository.create({ tenantId: tenant.id, agentId: agent.id, toolId: tool.id });

    const { agentRepository } = await import("../repositories/agent.repository.js");
    await agentRepository.updateById(agent.id, tenant.id, { isActive: false });

    const result = await checkPermission(agent.id, tool.id, tenant.id);
    expect(result).toEqual({ granted: false, reason: "agent_inactive" });

    await cleanupTenant(tenant.id);
  });

  it("denies with reason 'tool_inactive' when the tool is deactivated mid-grant", async () => {
    const tenant = await createTestTenant();
    const { agent } = await createTestAgent(tenant.id, tenant.ownerUserId);
    const tool = await createTestTool(tenant.id);
    await permissionRepository.create({ tenantId: tenant.id, agentId: agent.id, toolId: tool.id });

    const { toolRepository } = await import("../repositories/tool.repository.js");
    await toolRepository.updateById(tool.id, tenant.id, { isActive: false });

    const result = await checkPermission(agent.id, tool.id, tenant.id);
    expect(result).toEqual({ granted: false, reason: "tool_inactive" });

    await cleanupTenant(tenant.id);
  });

  it("fails CLOSED with reason 'error' when the repository throws", async () => {
    const spy = vi
      .spyOn(permissionRepository, "findGrantWithContext")
      .mockRejectedValue(new Error("connection reset"));

    const result = await checkPermission("agent-x", "tool-y", "tenant-z");
    expect(result.granted).toBe(false);
    expect((result as any).reason).toBe("error");

    spy.mockRestore();
  });
});

describe("permissionService.assignPermission — cross-tenant guard", () => {
  it("rejects assigning Tenant B's tool to Tenant A's agent", async () => {
    const tenantA = await createTestTenant();
    const tenantB = await createTestTenant();
    const { agent } = await createTestAgent(tenantA.id, tenantA.ownerUserId);
    const tool = await createTestTool(tenantB.id);

    await expect(
      permissionService.assignPermission(tenantA.id, { agentId: agent.id, toolId: tool.id })
    ).rejects.toThrow();

    await cleanupTenant(tenantA.id);
    await cleanupTenant(tenantB.id);
  });

  it("rejects assigning Tenant B's agent to Tenant A's tool", async () => {
    const tenantA = await createTestTenant();
    const tenantB = await createTestTenant();
    const { agent } = await createTestAgent(tenantB.id, tenantB.ownerUserId);
    const tool = await createTestTool(tenantA.id);

    await expect(
      permissionService.assignPermission(tenantA.id, { agentId: agent.id, toolId: tool.id })
    ).rejects.toThrow();

    await cleanupTenant(tenantA.id);
    await cleanupTenant(tenantB.id);
  });
});
```

**Step 6 — `checkPermission()` latency bench (`src/__tests__/permission-latency.test.ts`) (30 min)**

```typescript
import { describe, it, expect } from "vitest";
import { checkPermission } from "../lib/permission-engine.js";
import { permissionRepository } from "../repositories/permission.repository.js";
import {
  createTestTenant,
  createTestAgent,
  createTestTool,
  cleanupTenant,
} from "./helpers/test-tenant.factory.js";

/**
 * Not an official PRD gate the way the <5ms Redis rate-limit target
 * is — PRD §12 only names the Redis side explicitly. But by Week 6,
 * checkPermission()'s Postgres round trip and checkRateLimit()'s
 * Redis round trip both run SEQUENTIALLY in front of executeTool(),
 * inside the same 300ms p95 gateway-overhead budget (PRD §12 /
 * roadmap.md Week 8 gate #2). Spending more than a small slice of
 * that budget on the two guard checks combined would be a red flag
 * worth catching now, not in Week 8.
 *
 * 10ms is a deliberately generous ceiling for a single indexed-FK
 * join query against local Postgres — same "measure, don't assume"
 * discipline as Day 4's Redis bench, just with a looser bound since
 * Postgres over a real network in production will cost more than
 * localhost.
 */
describe("checkPermission — latency (informal budget: p95 < 10ms, local Postgres)", () => {
  it("p95 latency stays comfortably under budget against local Postgres", async () => {
    const tenant = await createTestTenant();
    const { agent } = await createTestAgent(tenant.id, tenant.ownerUserId);
    const tool = await createTestTool(tenant.id);
    await permissionRepository.create({ tenantId: tenant.id, agentId: agent.id, toolId: tool.id });

    const samples: number[] = [];
    for (let i = 0; i < 200; i++) {
      const start = performance.now();
      await checkPermission(agent.id, tool.id, tenant.id);
      samples.push(performance.now() - start);
    }

    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor(samples.length * 0.95)];
    // eslint-disable-next-line no-console
    console.log(`checkPermission p95 latency (local Postgres): ${p95.toFixed(2)}ms`);

    expect(p95).toBeLessThan(10);

    await cleanupTenant(tenant.id);
  });
});
```

### ✅ Day 2 Checkpoint

- [ ] Full permission lifecycle works via curl: assign → list → revoke
- [ ] `checkPermission` returns the correct `reason` for each of: granted, not_found, tenant_suspended, permission_inactive, agent_inactive, tool_inactive, error
- [ ] Cross-tenant assignment rejected in both directions (foreign agent, foreign tool)
- [ ] Fail-closed test passes (mocked repository throw → `granted:false, reason:'error'`, never `granted:true`)
- [ ] `checkPermission` latency bench passes and p95 is logged
- [ ] `npm test` passes; `npx tsc --noEmit` — zero errors

---

## Day 3 — A Dedicated Redis Connection for the Rate Limiter & the Atomic Lua Script

**Hours target:** 5–6h

### Concept Primer (~30 min)

**The shared `redis.ts` client already has a job, and it isn't this one.** Your actual `redis.ts` already sets `maxRetriesPerRequest: null`, per its own existing comment: *"Required by BullMQ Workers — without this, ioredis throws when a blocking command... can't connect."* That's already correct and doesn't need re-verifying — it's confirmed directly from the file. The rate limiter's circuit breaker (Day 5) needs the *opposite* property on whatever connection it uses: a LOW `maxRetriesPerRequest` and a short `commandTimeout`, so a single `checkRateLimit()` call fails fast and predictably instead of ioredis silently retrying underneath the breaker for several seconds — which would blind the breaker's failure counting to what's actually happening in anything like real time. These two requirements directly contradict each other on one client instance. Not a preference; sharing the client would break one of the two use cases.

**The fix is a second, dedicated ioredis client — colocated with its only consumer.** Rather than a separate `rate-limit-redis.ts` file, the dedicated client is defined directly at the top of `src/lib/rate-limiter.ts` — the module that owns it and is its only consumer. This avoids tempting some unrelated future code to import a generically-named Redis client file for an unrelated purpose; if you ever need this client elsewhere, that's a sign `checkRateLimit`'s exported surface should grow, not that something should reach around it. Same underlying principle as the dedicated-connection-per-pub/sub-subscriber pattern already planned for Week 7 — different Redis usage patterns get different connections, full stop.

**Match your existing import convention.** Your actual `redis.ts` imports ioredis as `import { Redis } from "ioredis";` — a named import. Whatever your `tsconfig.json`'s module interop settings actually allow, your existing file already proves this form works in your setup, so the new client uses the identical import rather than introducing a second, unverified style.

**The ioredis gotcha that will crash your process if you skip it — applies to every client you create.** `Redis` extends Node's `EventEmitter`. An `EventEmitter` that emits an `'error'` event with **no listener attached** throws — synchronously, uncatchably, crashing the whole process. The fix is one line per client: `.on("error", (err) => { ... })`.

**Fixed-window key design.** `rate:agent:<agentId>:min:<epochMinute>` — a fresh key every 60 seconds, keyed per agent. `EXPIRE key 120` (2× the window) is set only when the key is first created (`INCR` returns `1`), not on every call — the key naturally rolls over to a new name every minute anyway.

### Build Block

**Step 1 — The dedicated client + Lua script registration (`src/lib/rate-limiter.ts`) (1.5h)**

This is a new file. By the end of the week it's the complete, self-contained rate-limiting module: its own Redis connection, its own atomic primitive, its own decision logic, its own breaker. Days 4 and 5 append to this same file rather than creating new ones.

```typescript
import { Redis } from "ioredis";
import { env } from "../config/env.js";

/**
 * A DEDICATED ioredis connection — deliberately separate from the
 * shared client in `redis.ts` that BullMQ uses (email queue now,
 * audit queue from Week 5 on).
 *
 * WHY TWO CLIENTS, NOT ONE:
 * `redis.ts` sets `maxRetriesPerRequest: null` — required by BullMQ:
 * without it, ioredis throws when one of BullMQ's internal blocking
 * commands can't immediately connect. This client needs the OPPOSITE
 * property: a LOW maxRetriesPerRequest and a short commandTimeout,
 * so a single checkRateLimit() call fails fast and predictably
 * instead of ioredis silently retrying underneath the circuit
 * breaker (Day 5) for several seconds — which would blind the
 * breaker's failure counting to what's actually happening in
 * anything like real time. These two requirements are directly
 * contradictory on one client instance.
 *
 * Colocated here rather than in its own file: this client has
 * exactly one consumer (this module). If something else ever needs
 * it, that's a signal to extend this module's exported functions,
 * not to reach around them for the raw client.
 */
export const rateLimiterRedis = new Redis(env.AGENTGATE_REDIS_URL, {
  maxRetriesPerRequest: 1,
  commandTimeout: 1000,

  retryStrategy(times: number) {
    return Math.min(times * 200, 2000);
  },

  reconnectOnError(err: Error) {
    return err.message.includes("READONLY") || err.message.includes("ECONNRESET");
  },
});

// Same gotcha as any ioredis client: an unhandled 'error' event
// crashes the process. Swap console.error for your shared pino
// instance if src/lib/logger.ts exists in your tree.
rateLimiterRedis.on("error", (err) => {
  console.error("[rate-limiter-redis] connection error:", err.message);
});

// Extends ioredis's type so TypeScript knows about the custom
// command registered below — without this, `rateLimiterRedis
// .rateLimitIncr(...)` won't type-check.
declare module "ioredis" {
  interface RedisCommander<Context> {
    rateLimitIncr(key: string, ttlSeconds: string | number): Promise<number>;
  }
}

export const RATE_LIMIT_KEY_TTL_SECONDS = 120; // 2x the 60s window

/**
 * Atomically increments the per-minute counter for a key, setting a
 * TTL only on the call that creates the key (current === 1). This is
 * the ONLY thing this Lua script does — the "is this over the
 * limit" decision deliberately does NOT live here. See Key
 * Decision #6.
 */
rateLimiterRedis.defineCommand("rateLimitIncr", {
  numberOfKeys: 1,
  lua: `
    local current = redis.call("INCR", KEYS[1])
    if current == 1 then
      redis.call("EXPIRE", KEYS[1], ARGV[1])
    end
    return current
  `,
});

export function rateLimitKey(agentId: string): string {
  const epochMinute = Math.floor(Date.now() / 60_000);
  return `rate:agent:${agentId}:min:${epochMinute}`;
}
```

**Step 2 — Wire the new client into `server.ts`'s graceful shutdown (15 min)**

Easy to forget since it's a one-line addition to a file you're not otherwise touching this week — but skipping it leaks a live connection on every restart. Same class of bug the Single Cleanup Function principle exists to prevent elsewhere in this project.

```typescript
// server.ts — alongside your existing shutdown sequence
import { rateLimiterRedis } from "./lib/rate-limiter.js";

const shutdown = async (signal: string) => {
  app.log.info(`Received ${signal} — initiating graceful shutdown...`);
  try {
    await app.close();
    await emailWorker.close();
    await emailQueue.close();
    await redis.quit();
    await rateLimiterRedis.quit();   // ADD THIS LINE
    await prisma.$disconnect();
    app.log.info("Server closed gracefully.");
    process.exit(0);
  } catch (err) {
    app.log.error(err, "Error during shutdown");
    process.exit(1);
  }
};
```

**Step 3 — Prove atomicity standalone, against real Redis, before anything else depends on it (1h)**

A permanent regression test, not a throwaway script — it runs against a real local Redis (`docker compose up -d redis`), not a mock, because it exists specifically to verify a guarantee Redis itself makes, not application logic.

`src/__tests__/rate-limiter.atomicity.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { rateLimiterRedis, RATE_LIMIT_KEY_TTL_SECONDS } from "../lib/rate-limiter.js";

describe("Lua script atomicity (raw, standalone — proves the primitive before building on it)", () => {
  it("produces a gap-free, duplicate-free sequence under 50 concurrent INCRs", async () => {
    const key = `atomicity-test:${crypto.randomUUID()}`;

    const results = await Promise.all(
      Array.from({ length: 50 }, () => rateLimiterRedis.rateLimitIncr(key, RATE_LIMIT_KEY_TTL_SECONDS))
    );

    const sorted = [...results].sort((a, b) => a - b);
    const expected = Array.from({ length: 50 }, (_, i) => i + 1);

    // If this ever fails, the bug is in the Lua script or in Redis's
    // atomicity guarantee itself — NOT in checkRateLimit's decision
    // logic (Day 4), which hasn't been written yet at this point.
    expect(sorted).toEqual(expected);
  });

  it("sets a TTL only once — the key expires within the 120s window, not sooner or indefinitely", async () => {
    const key = `ttl-test:${crypto.randomUUID()}`;
    await rateLimiterRedis.rateLimitIncr(key, RATE_LIMIT_KEY_TTL_SECONDS);
    await rateLimiterRedis.rateLimitIncr(key, RATE_LIMIT_KEY_TTL_SECONDS); // second call, same key

    const ttl = await rateLimiterRedis.ttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(RATE_LIMIT_KEY_TTL_SECONDS);
  });
});
```

### ✅ Day 3 Checkpoint

- [ ] `src/lib/redis.ts` is untouched — already correctly set to `maxRetriesPerRequest: null` for BullMQ (confirmed directly from the existing file; nothing to change here)
- [ ] `rateLimiterRedis` uses the same `import { Redis } from "ioredis"` convention as the existing file, not a different import style
- [ ] `rateLimiterRedis.on("error", ...)` listener present — confirm by stopping local Redis briefly and checking the process does NOT crash, only logs
- [ ] `server.ts`'s shutdown sequence now closes BOTH `redis` and `rateLimiterRedis`
- [ ] Atomicity test passes against real local Redis: exactly the integers 1–50, no duplicates, no gaps
- [ ] TTL test confirms the key expires within the 120s window
- [ ] `npx tsc --noEmit` — zero errors (the `declare module "ioredis"` augmentation resolves cleanly)

---

## Day 4 — `checkRateLimit()`: The Decision Layer, Concurrency Proof & Latency Bench

**Hours target:** 5h

### Concept Primer (~15 min)

**Why the comparison lives in TypeScript, restated concretely.** Whether `count <= limit` is computed inside the Lua script or in the calling TypeScript code, correctness is identical either way — it depends only on `INCR`'s atomicity, which Day 3 already proved. Given equal correctness, the tie-breaker is testability: `evaluateRateLimit(count, limit)` as a bare function tests in a single assertion, with zero Redis involved, zero mocking, zero async.

**`remaining` floors at zero.** Once an agent is over its limit, the counter keeps incrementing on every subsequent call within the same minute — there's no reason to stop it, since the key expires naturally in at most 120 seconds regardless of how high it climbs. `remaining` must clamp at `0`, never go negative.

### Build Block

**Step 1 — Pure decision function, appended to `src/lib/rate-limiter.ts` (20 min)**

```typescript
export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  degraded: boolean; // true when this decision did NOT come from a live Redis check — see Day 5
}

/**
 * Pure. No Redis, no async, no side effects — trivially and
 * exhaustively unit-testable. See Key Decision #6 for why this logic
 * doesn't live inside the Lua script.
 */
export function evaluateRateLimit(count: number, limit: number): { allowed: boolean; remaining: number } {
  return {
    allowed: count <= limit,
    remaining: Math.max(0, limit - count),
  };
}
```

**Step 2 — `checkRateLimit()` wrapper, appended to the same file (30 min)**

This version has no failure handling yet — Day 5 wraps it with the circuit breaker without touching this function's body. Keeping this step separate is deliberate: prove the happy path in isolation first.

```typescript
export async function checkRateLimit(agentId: string, limit: number): Promise<RateLimitResult> {
  const key = rateLimitKey(agentId);
  const count = await rateLimiterRedis.rateLimitIncr(key, RATE_LIMIT_KEY_TTL_SECONDS);
  return { ...evaluateRateLimit(count, limit), degraded: false };
}
```

**Step 3 — Pure-function unit tests (`src/__tests__/rate-limit-decision.test.ts`) (20 min)**

```typescript
import { describe, it, expect } from "vitest";
import { evaluateRateLimit } from "../lib/rate-limiter.js";

describe("evaluateRateLimit (pure — no Redis)", () => {
  it("allows when count is at or below the limit", () => {
    expect(evaluateRateLimit(1, 10)).toEqual({ allowed: true, remaining: 9 });
    expect(evaluateRateLimit(10, 10)).toEqual({ allowed: true, remaining: 0 });
  });

  it("denies when count exceeds the limit", () => {
    expect(evaluateRateLimit(11, 10)).toEqual({ allowed: false, remaining: 0 });
  });

  it("remaining never goes negative, even far over limit", () => {
    expect(evaluateRateLimit(1000, 10).remaining).toBe(0);
  });
});
```

**Step 4 — The official concurrency proof (`src/__tests__/rate-limit-concurrency.test.ts`) (1h)**

20 simultaneous calls, limit 10, exactly 10 allowed and exactly 10 denied — no race conditions, no over- or under-counting.

```typescript
import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { checkRateLimit } from "../lib/rate-limiter.js";

describe("checkRateLimit — concurrency proof", () => {
  it("allows exactly 10 and denies exactly 10 under 20 truly concurrent calls with limit=10", async () => {
    const agentId = `concurrency-test-${crypto.randomUUID()}`;

    // Promise.all fires all 20 calls before any of them resolve —
    // this is what makes "concurrent" true here. The atomicity
    // guarantee comes from Redis executing the Lua script
    // single-threaded server-side, not from any client-side ordering.
    const results = await Promise.all(
      Array.from({ length: 20 }, () => checkRateLimit(agentId, 10))
    );

    const allowedCount = results.filter((r) => r.allowed).length;
    const deniedCount = results.filter((r) => !r.allowed).length;

    expect(allowedCount).toBe(10);
    expect(deniedCount).toBe(10);
  });

  it("is exactly right across multiple repeated runs, not just once", async () => {
    for (let i = 0; i < 5; i++) {
      const agentId = `concurrency-repeat-${i}-${crypto.randomUUID()}`;
      const results = await Promise.all(
        Array.from({ length: 20 }, () => checkRateLimit(agentId, 10))
      );
      expect(results.filter((r) => r.allowed).length).toBe(10);
    }
  });
});
```

**Step 5 — Empirically validate the PRD §12 latency target (`src/__tests__/rate-limit-latency.test.ts`) (45 min)**

PRD §12 states the rate limit check must be a Redis operation under 5ms. Measure it — don't assume it.

```typescript
import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { checkRateLimit } from "../lib/rate-limiter.js";

describe("checkRateLimit — latency (PRD §12 target: p95 < 5ms)", () => {
  it("p95 latency stays under 5ms against local Redis", async () => {
    const agentId = `latency-test-${crypto.randomUUID()}`;
    const samples: number[] = [];

    for (let i = 0; i < 200; i++) {
      const start = performance.now();
      await checkRateLimit(agentId, 100_000); // effectively unlimited — measuring latency, not denial
      samples.push(performance.now() - start);
    }

    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor(samples.length * 0.95)];
    // eslint-disable-next-line no-console
    console.log(`checkRateLimit p95 latency (local Redis): ${p95.toFixed(2)}ms`);

    expect(p95).toBeLessThan(5);
  });
});
```

This measures latency against a local Docker Redis on the same machine. A managed Redis instance over a real network (Railway, Render, ElastiCache, Upstash) will add real round-trip time — re-running this same test against your actual deployment target is now an explicit Week 8 checklist item (Day 6, below), not just a caveat to remember.

### ✅ Day 4 Checkpoint

- [ ] `evaluateRateLimit` unit tests pass (pure, no Redis)
- [ ] Concurrency proof passes: exactly 10 allowed / 10 denied, across 5 repeated runs
- [ ] Latency test passes locally; latency measured (not assumed) and logged
- [ ] `npx tsc --noEmit` — zero errors

---

## Day 5 — The Hybrid Circuit Breaker

**Hours target:** 5–6h — the most design-critical day this week, same spirit as Week 2's encryption day.

### Concept Primer (~30 min)

**Why neither static policy is acceptable.** A pure fail-open rate limiter defeats the entire purpose of having one the moment Redis has a bad day. A pure fail-closed rate limiter turns one dropped TCP connection into a full gateway outage for every agent across every tenant, over something that isn't a rate-limit violation at all.

**The shape of the hybrid — three states, not two.**
- **CLOSED** (healthy): normal atomic checking. Individual failures below a threshold fail OPEN for that single call; a single subsequent success resets the failure count to zero.
- **OPEN** (tripped): once consecutive failures cross the threshold, stop even *attempting* Redis — fail CLOSED immediately, for a fixed cooldown.
- **HALF_OPEN** (probing): after the cooldown elapses, let exactly one call through as a live test. Success resets to CLOSED. Failure sends it back to OPEN and restarts the cooldown.

**Why in-process state is correct, not just an MVP shortcut.** The breaker's state lives in a module-level object in a single Node.js process — the same limitation class as the Session Map (HLD §3.1). Centralizing breaker state in Redis would be circular the moment Redis itself is the thing that's down. Per-process state is the architecturally correct answer, not a compromise to revisit later.

**Precision on two accepted imprecisions — worth stating exactly, not loosely:**

*The fail-open window is bounded by time, not by call count.* `canAttempt()` is checked *before* the async Redis call; state only updates *after* it resolves. If Redis is slow rather than instantly erroring (hanging up to the 1s `commandTimeout`), a burst of concurrent calls can all pass `canAttempt()` while still CLOSED, all attempt Redis simultaneously, and all fail together once each individually times out — not "the first two, sequentially." In practice this window is bounded to roughly one `commandTimeout` cycle (~1–2s), so it isn't a serious problem — just don't describe it as an exact per-call bound, since concurrency makes "first" and "Nth" undefined for overlapping calls.

*Concurrent `HALF_OPEN` probes resolve last-writer-wins.* If two probes are in flight and the slower one succeeds after the faster one already failed and re-tripped the breaker OPEN, the late success resets straight back to CLOSED — silently overriding the more recent failure. Self-correcting within the next request or two, low severity, but a specific nameable race, not just "a couple of extra Redis attempts." Not worth a locking mechanism for an MVP breaker.

### Build Block

**Step 1 — The breaker (`src/lib/circuit-breaker.ts`) (1.5h)**

```typescript
export type BreakerState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitBreakerConfig {
  failureThreshold: number;
  cooldownMs: number;
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 3,
  cooldownMs: 15_000,
};

/**
 * A small, dependency-free circuit breaker. Named generically (not
 * "RateLimiterCircuitBreaker") because the state machine itself has
 * nothing rate-limiter-specific about it — a reusable pattern for
 * any Redis-dependent (or otherwise flaky) operation you later want
 * the same hybrid behavior for. Today it wraps exactly one thing:
 * checkRateLimit.
 *
 * TWO PRECISE, ACCEPTED IMPRECISIONS — documented here so nobody
 * assumes a stronger guarantee than what's actually implemented:
 *
 * 1. The fail-open window below the trip threshold is bounded by
 *    TIME (~one commandTimeout cycle), not by an exact call count.
 *    canAttempt() is checked before the async operation starts, and
 *    state only updates after it resolves — so a burst of
 *    concurrent calls can all see CLOSED, all attempt Redis
 *    together, and all fail together once each individually times
 *    out. This is NOT "exactly the first N-1 calls fail open, the
 *    Nth trips it" — concurrency makes "first" and "Nth" undefined
 *    for calls overlapping in flight.
 *
 * 2. Concurrent HALF_OPEN probes resolve last-writer-wins: if a
 *    slower probe succeeds after a faster one already failed and
 *    re-tripped the breaker OPEN, the late success resets straight
 *    back to CLOSED, silently overriding the more recent failure.
 *    Self-correcting within the next request or two; not worth a
 *    lock for an MVP breaker, but worth knowing precisely.
 */
export class CircuitBreaker {
  private state: BreakerState = "CLOSED";
  private consecutiveFailures = 0;
  private openedAt: number | null = null;

  constructor(private config: CircuitBreakerConfig = DEFAULT_CONFIG) {}

  /**
   * Should the caller even attempt the underlying operation?
   * Call this BEFORE attempting Redis.
   */
  canAttempt(): boolean {
    if (this.state === "CLOSED") return true;

    if (this.state === "OPEN") {
      const elapsed = Date.now() - (this.openedAt ?? 0);
      if (elapsed >= this.config.cooldownMs) {
        this.state = "HALF_OPEN";
        return true; // this call becomes a probe
      }
      return false;
    }

    // HALF_OPEN: allow it through as a probe. See imprecision #2
    // in the class docstring above re: multiple concurrent probes.
    return true;
  }

  /** Call after the underlying operation succeeds. */
  onSuccess(): void {
    this.consecutiveFailures = 0;
    this.state = "CLOSED";
    this.openedAt = null;
  }

  /** Call after the underlying operation throws. */
  onFailure(): void {
    this.consecutiveFailures += 1;
    if (this.state === "HALF_OPEN" || this.consecutiveFailures >= this.config.failureThreshold) {
      this.state = "OPEN";
      this.openedAt = Date.now();
    }
  }

  getState(): BreakerState {
    return this.state;
  }

  /** Test-only: force back to a clean CLOSED state between test cases. */
  reset(): void {
    this.state = "CLOSED";
    this.consecutiveFailures = 0;
    this.openedAt = null;
  }
}
```

**Step 2 — Wire the breaker into `checkRateLimit()` (`src/lib/rate-limiter.ts`) (1h)**

Replace Day 4's bare `checkRateLimit` with this version. The pure `evaluateRateLimit` function and the Lua registration from Days 3–4 are untouched — only this one function's body changes.

```typescript
import { CircuitBreaker } from "./circuit-breaker.js";

const rateLimiterBreaker = new CircuitBreaker({
  failureThreshold: 3,
  cooldownMs: 15_000,
});

// Exported so tests and the /health route can both reach it without
// reimporting internals.
export function getRateLimiterBreaker(): CircuitBreaker {
  return rateLimiterBreaker;
}

export async function checkRateLimit(agentId: string, limit: number): Promise<RateLimitResult> {
  if (!rateLimiterBreaker.canAttempt()) {
    console.warn(`[rate-limiter] circuit OPEN — failing closed for agent ${agentId}`);
    return { allowed: false, remaining: 0, degraded: true };
  }

  const key = rateLimitKey(agentId);
  try {
    const count = await rateLimiterRedis.rateLimitIncr(key, RATE_LIMIT_KEY_TTL_SECONDS);
    rateLimiterBreaker.onSuccess();
    return { ...evaluateRateLimit(count, limit), degraded: false };
  } catch (err) {
    rateLimiterBreaker.onFailure();

    if (rateLimiterBreaker.getState() === "OPEN") {
      console.error(`[rate-limiter] breaker tripped OPEN for agent ${agentId}:`, err);
      return { allowed: false, remaining: 0, degraded: true };
    }

    // Still below the trip threshold — brief, bounded fail-OPEN.
    console.warn(`[rate-limiter] degraded — failing open (below trip threshold) for agent ${agentId}:`, err);
    return { allowed: true, remaining: limit, degraded: true };
  }
}

export function getRateLimiterHealth(): { healthy: boolean; breakerState: BreakerState } {
  const state = rateLimiterBreaker.getState();
  return { healthy: state !== "OPEN", breakerState: state };
}
```

**A note for M6 (Week 6), not built yet:** a `degraded: true` result means this decision did NOT come from a real policy check. The straightforward mapping is `degraded && !allowed` → `-32603 Internal Error`, not `-32001 Rate Limited` — same "don't conflate a system fault with a policy decision" principle as `checkPermission`'s `reason: "error"` case. Worth a dedicated `-32002 Service Degraded` code instead of collapsing both into the generic `-32603` when M6 exists — nothing to build today, just don't let `degraded` get thrown away before M6 needs it.

**Step 3 — Health check tie-in (30 min)**

You already have a `/health` endpoint. Expose the breaker's state as a **second, independent** signal — not a restatement of your existing Redis `PING`. After today, "is Redis healthy" is genuinely two separate questions: is the shared client (serving BullMQ) reachable, and is the rate limiter's dedicated client's circuit breaker CLOSED. They can diverge — the breaker could be OPEN while BullMQ's connection is fine, or vice versa.

```typescript
import { getRateLimiterHealth } from "../lib/rate-limiter.js";

// ...inside your existing health handler:
const rateLimiter = getRateLimiterHealth();
// Report this as details.rateLimiter, distinct from details.redis
// (the shared BullMQ-serving client's PING result). Fold
// `rateLimiter.healthy` into your overall status determination the
// same way you already fold in the Postgres/Redis checks, but don't
// let either signal overwrite the other.
```

**Step 4 — Breaker unit tests (`src/__tests__/circuit-breaker.test.ts`) (1h)**

Entirely in-memory, zero Redis, zero mocking.

```typescript
import { describe, it, expect } from "vitest";
import { CircuitBreaker } from "../lib/circuit-breaker.js";

describe("CircuitBreaker", () => {
  it("stays CLOSED and keeps attempting under the failure threshold", () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000 });
    breaker.onFailure();
    breaker.onFailure();
    expect(breaker.getState()).toBe("CLOSED");
    expect(breaker.canAttempt()).toBe(true);
  });

  it("trips OPEN exactly when the failure threshold is reached", () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000 });
    breaker.onFailure();
    breaker.onFailure();
    breaker.onFailure();
    expect(breaker.getState()).toBe("OPEN");
    expect(breaker.canAttempt()).toBe(false);
  });

  it("moves to HALF_OPEN and allows exactly one probe after the cooldown elapses", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 50 });
    breaker.onFailure();
    expect(breaker.canAttempt()).toBe(false);

    await new Promise((r) => setTimeout(r, 60));

    expect(breaker.canAttempt()).toBe(true);
    expect(breaker.getState()).toBe("HALF_OPEN");
  });

  it("a successful HALF_OPEN probe resets fully to CLOSED", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 50 });
    breaker.onFailure();
    await new Promise((r) => setTimeout(r, 60));
    breaker.canAttempt();
    breaker.onSuccess();
    expect(breaker.getState()).toBe("CLOSED");
  });

  it("a failed HALF_OPEN probe returns to OPEN and restarts the cooldown", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 50 });
    breaker.onFailure();
    await new Promise((r) => setTimeout(r, 60));
    breaker.canAttempt();
    breaker.onFailure();
    expect(breaker.getState()).toBe("OPEN");
    expect(breaker.canAttempt()).toBe(false);
  });

  it("a single success while CLOSED resets the consecutive-failure counter", () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000 });
    breaker.onFailure();
    breaker.onFailure();
    breaker.onSuccess();
    breaker.onFailure();
    breaker.onFailure();
    expect(breaker.getState()).toBe("CLOSED");
  });
});
```

**Step 5 — Integration test proving the wiring into `checkRateLimit` (`src/__tests__/rate-limit-breaker-integration.test.ts`) (1h)**

Mock the Redis-calling method directly with Vitest for deterministic rejections, rather than trying to actually kill a Docker container mid-test.

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { rateLimiterRedis, checkRateLimit, getRateLimiterBreaker } from "../lib/rate-limiter.js";

describe("checkRateLimit + CircuitBreaker — integration", () => {
  beforeEach(() => {
    getRateLimiterBreaker().reset();
  });

  it("fails OPEN below the trip threshold, then fails CLOSED once tripped, without touching Redis again", async () => {
    const spy = vi.spyOn(rateLimiterRedis, "rateLimitIncr").mockRejectedValue(new Error("ECONNREFUSED"));

    const r1 = await checkRateLimit("agent-breaker-test", 10);
    expect(r1).toEqual({ allowed: true, remaining: 10, degraded: true }); // 1st failure — fail open

    const r2 = await checkRateLimit("agent-breaker-test", 10);
    expect(r2.allowed).toBe(true); // 2nd failure — still below threshold=3

    const r3 = await checkRateLimit("agent-breaker-test", 10);
    expect(r3.allowed).toBe(false); // 3rd failure trips the breaker -> fail closed

    const r4 = await checkRateLimit("agent-breaker-test", 10);
    expect(r4.allowed).toBe(false); // breaker OPEN -> fails closed WITHOUT attempting Redis

    expect(spy).toHaveBeenCalledTimes(3); // proves the 4th call never touched Redis at all

    spy.mockRestore();
  });

  it("recovers to normal operation once Redis comes back and the cooldown elapses", async () => {
    const breaker = getRateLimiterBreaker();
    const spy = vi.spyOn(rateLimiterRedis, "rateLimitIncr").mockRejectedValue(new Error("ECONNREFUSED"));

    await checkRateLimit("agent-recovery-test", 10);
    await checkRateLimit("agent-recovery-test", 10);
    await checkRateLimit("agent-recovery-test", 10); // trips OPEN

    expect(breaker.getState()).toBe("OPEN");

    spy.mockResolvedValue(1);
    // NOTE: in the real breaker this requires waiting cooldownMs —
    // for a fast test, configure a short cooldown for this suite
    // specifically, or advance Vitest's fake timers here.

    spy.mockRestore();
  });
});
```

### ✅ Day 5 Checkpoint

- [ ] Breaker unit tests pass — all six state-transition scenarios green, zero Redis involved
- [ ] Integration test proves fail-open for the first `failureThreshold - 1` failures, fail-closed once tripped, and — critically — that Redis is NOT re-attempted while OPEN (assert the spy's call count directly)
- [ ] `/health` reflects `breakerState` as its own distinct field when OPEN
- [ ] `npx tsc --noEmit` — zero errors

---

## Day 6 — Integration Testing, Official Proof Checkpoint & Code Review

**Hours target:** 5h — a confirmatory day, not a new-feature day, same spirit as Week 2's Day 6.

### Build Block

**Step 1 — The five official Week 3 gates, assembled in one file (`src/__tests__/week3-checkpoint.test.ts`) (1.5h)**

Individually these already passed on Days 2, 4, and 5 — this file exists so the whole week's gate can be run and reviewed as one unit.

```typescript
import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { checkRateLimit, getRateLimiterBreaker } from "../lib/rate-limiter.js";
import { checkPermission } from "../lib/permission-engine.js";
import { permissionRepository } from "../repositories/permission.repository.js";
import { permissionService } from "../services/permission.service.js";
import { agentRepository } from "../repositories/agent.repository.js";
import {
  createTestTenant,
  createTestAgent,
  createTestTool,
  cleanupTenant,
} from "./helpers/test-tenant.factory.js";

describe("Week 3 Proof Checkpoint", () => {
  it("GATE 1 — concurrency: exactly 10 allowed / 10 denied under 20 simultaneous calls, limit=10", async () => {
    const agentId = `gate1-${crypto.randomUUID()}`;
    const results = await Promise.all(Array.from({ length: 20 }, () => checkRateLimit(agentId, 10)));
    expect(results.filter((r) => r.allowed).length).toBe(10);
    expect(results.filter((r) => !r.allowed).length).toBe(10);
  });

  it("GATE 2 — cross-tenant isolation: Tenant A cannot be granted a permission touching Tenant B's agent or tool", async () => {
    const tenantA = await createTestTenant();
    const tenantB = await createTestTenant();
    const { agent: agentA } = await createTestAgent(tenantA.id, tenantA.ownerUserId);
    const toolB = await createTestTool(tenantB.id);

    await expect(
      permissionService.assignPermission(tenantA.id, { agentId: agentA.id, toolId: toolB.id })
    ).rejects.toThrow();

    await cleanupTenant(tenantA.id);
    await cleanupTenant(tenantB.id);
  });

  it("GATE 3 — suspending a tenant immediately blocks checkPermission for every agent underneath it, agent/tool/permission rows untouched", async () => {
    const tenant = await createTestTenant();
    const { agent } = await createTestAgent(tenant.id, tenant.ownerUserId);
    const tool = await createTestTool(tenant.id);
    await permissionRepository.create({ tenantId: tenant.id, agentId: agent.id, toolId: tool.id });

    expect((await checkPermission(agent.id, tool.id, tenant.id)).granted).toBe(true);

    // Direct Prisma call, not a speculative repository method — this
    // is guaranteed to work regardless of what tenant.repository.ts
    // exposes, and matches the real schema field (deletedAt, not a
    // guessed isActive).
    await prisma.tenant.update({ where: { id: tenant.id }, data: { deletedAt: new Date() } });

    const result = await checkPermission(agent.id, tool.id, tenant.id);
    expect(result.granted).toBe(false);
    expect((result as any).reason).toBe("tenant_suspended");

    await cleanupTenant(tenant.id);
  });

  it("GATE 4 — deactivating an agent mid-session immediately blocks checkPermission, not just new connections", async () => {
    const tenant = await createTestTenant();
    const { agent } = await createTestAgent(tenant.id, tenant.ownerUserId);
    const tool = await createTestTool(tenant.id);
    await permissionRepository.create({ tenantId: tenant.id, agentId: agent.id, toolId: tool.id });

    expect((await checkPermission(agent.id, tool.id, tenant.id)).granted).toBe(true);

    await agentRepository.updateById(agent.id, tenant.id, { isActive: false });

    const result = await checkPermission(agent.id, tool.id, tenant.id);
    expect(result.granted).toBe(false);
    expect((result as any).reason).toBe("agent_inactive");

    await cleanupTenant(tenant.id);
  });

  it("GATE 5 — circuit breaker completes a full CLOSED -> OPEN -> HALF_OPEN -> CLOSED cycle", async () => {
    const breaker = getRateLimiterBreaker();
    breaker.reset();

    expect(breaker.getState()).toBe("CLOSED");
    breaker.onFailure();
    breaker.onFailure();
    breaker.onFailure();
    expect(breaker.getState()).toBe("OPEN");
    breaker.onSuccess(); // simulating a manual recovery signal for this assembled test
    expect(breaker.getState()).toBe("CLOSED");
  });
});
```

Note: `checkPermission()`'s latency was already benched on Day 2 (`permission-latency.test.ts`) — no need to recreate that file here. Re-run it as part of today's full-suite pass and carry the recorded p95 number into this week's `PROGRESS.md` entry, alongside `checkRateLimit`'s.

**Step 2 — Code review pass (1h)**

Go through every file added this week and check:

- [ ] `permission.repository.ts` and every `agent_tool_permission`-touching query takes `tenantId` — no exceptions, no repeat of the Week 1 tenant-scoping gaps
- [ ] `checkPermission()` never returns a bare `true`/`false` anywhere that would collapse "denied" and "error" together
- [ ] No route response includes internal error objects from a `reason: 'error'` result — sanitize before sending to the client (your global `setErrorHandler` from Week 1 already does this for 5xx; confirm the permission routes don't bypass it)
- [ ] `ajv` is an explicit dependency in `package.json` (carried over from the Week 2 review)
- [ ] `toolRoutes` registration in `app.ts` is confirmed present (carried over verification item)
- [ ] `src/lib/redis.ts` (BullMQ's client) and `rateLimiterRedis` (this week's dedicated client, inside `rate-limiter.ts`) are genuinely separate connections with independent settings — grep for any accidental cross-import
- [ ] Both Redis-touching modules (`redis.ts` and `rate-limiter.ts`) have an attached `'error'` listener
- [ ] `server.ts`'s shutdown sequence closes `rateLimiterRedis` alongside the existing `redis.quit()`
- [ ] Prisma's connection pool size has been explicitly decided (Day 7, below), not left at whatever the adapter's default happens to be
- [ ] The Day 4 Redis latency bench is scheduled to be re-run against your actual deployed Redis before Week 8's deployment gate — confirmed as an explicit checklist line there, not just a comment in this week's test file
- [ ] `npx tsc --noEmit` — zero errors
- [ ] `npm test` — full suite green, including the atomicity test against real local Redis

### ✅ Day 6 Checkpoint (Week 3 Gate)

**All of these must pass before proceeding to Week 4:**
- [ ] All five Week 3 Proof Checkpoint gates pass (concurrency, cross-tenant isolation, tenant-suspension, agent-deactivation, breaker full-cycle)
- [ ] `checkPermission` and `checkRateLimit` latency both measured and recorded, not assumed
- [ ] Code review checklist fully checked off, including all carried-over items from Week 2 and the new Redis-client-separation items
- [ ] `npx tsc --noEmit` — zero errors

---

## Day 7 — Buffer, Hardening & Week 4 Preview

**Hours target:** 3–4h (lighter day by design, same as Weeks 1 and 2)

### Block 1 — Catch-Up (as needed)

If any Day 1–6 checkpoint is incomplete, fix it now. The five Week 3 gates and the code review checklist are the non-negotiable bar — don't carry this debt into Week 4, where the Tool Executor will call `checkPermission` and `checkRateLimit` on every single invocation.

### Block 2 — Hardening

**Resolve `prisma.ts`'s connection-pool-size TODO (30 min)**

Your `prisma.ts` currently has an open `// TODO : define max connection pool size` next to the `PrismaPg` adapter construction. This week adds the first hot-path DB read (`checkPermission`) that will run on every future tool call — better to decide this deliberately now than discover a starved pool mid-way through the Week 6 or Week 8 concurrency tests.

Add to `src/config/env.ts`, alongside the other `AGENTGATE_` variables:

```typescript
AGENTGATE_DB_POOL_MAX: z.coerce.number().default(10),
```

Update `src/lib/prisma.ts`:

```typescript
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { env } from "../config/env.js";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter: new PrismaPg({
      connectionString: env.AGENTGATE_DATABASE_URL,
      max: env.AGENTGATE_DB_POOL_MAX,
    }),
    log: ["error", "warn"],
  });

if (env.AGENTGATE_NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
```

`max: 10` mirrors `node-postgres`'s own default and is a reasonable starting point for a single Fastify process — not a number derived from load testing. Treat it as "start here, measure under the Week 6 and Week 8 concurrency tests, adjust based on what you actually see," the same empirical posture as every other tuned constant in this project (the breaker's threshold/cooldown, the rate limiter's TTL). This single pool is shared by every concurrent Postgres read across the whole process — the REST API, `checkPermission` (from this week on), and Week 5's audit worker batch writes all draw from it, so it's worth revisiting once more than one of those is under real concurrent load simultaneously.

**Remaining hardening checks (30 min)**

- [ ] Confirm `docker compose down && docker compose up -d && npm run dev` still starts cleanly
- [ ] Confirm killing the local Redis container for a few seconds mid-run does NOT crash the process (the `.on("error", ...)` listener on `rateLimiterRedis`, proven live — and confirm the existing `redis.ts` listener still behaves the same way)
- [ ] Confirm the breaker's `console.warn`/`console.error` calls are visible in your logs during that same test — swap for your shared pino logger here if one exists
- [ ] Re-run the Day 4 latency benchmark once more, cold, and record the number in `PROGRESS.md`

### Block 3 — Week 4 Preview (20 min, skim only)

Week 4 builds the Tool Execution Pipeline (M4) — `executeTool()`, the HTTP/PostgreSQL/WebFetch handlers, `AbortController`-based timeouts. Skim, don't build:

- [MDN: AbortController](https://developer.mozilla.org/en-US/docs/Web/API/AbortController)
- [node-postgres: Parameterized Queries](https://node-postgres.com/features/queries#parameterized-query)

**One thing worth naming now, not designing now:** the HTTP, PostgreSQL, and WebFetch handlers all accept **tenant-configured targets** — a URL, a connection string. That's a textbook SSRF surface the moment it's built: a misconfigured or malicious tool pointing at a cloud metadata endpoint (`169.254.169.254`), an internal service port, or a `postgres://` connection string aimed at infrastructure that was never meant to be reachable from the gateway. Week 4's roadmap should plan a layered defense specifically for this — static IP/hostname validation at tool-creation time, and a second layer that re-validates at actual DNS-resolution time (closing the gap where a hostname that looked safe at creation resolves somewhere unsafe at call time — DNS rebinding). Not building any of this yet — just flagging it so Week 4 doesn't start cold on the single biggest new risk that milestone introduces.

**Two forward notes for Week 6 specifically**, surfaced by this week's work but not this week's to build:
- The SSE connect-time auth handler (HLD §6.1) currently only checks `agents.is_active`. It should also reject a suspended tenant's agents outright at connect time, the same way it already rejects a deactivated agent — this week's `checkPermission` recheck is the safety net for an *already-open* session, not a substitute for stopping a suspended tenant's agents from connecting in the first place.
- Consider a dedicated `-32002 Service Degraded` JSON-RPC code for the breaker-OPEN and permission-infrastructure-error cases, instead of collapsing both into the generic `-32603`. The `degraded` flag on `RateLimitResult` and the `reason: "error"` case on `PermissionCheckResult` already carry the information needed to make that distinction — don't let it get discarded before M6 needs it.

### Block 4 — `PROGRESS.md` Addition

Append to your existing `PROGRESS.md` (don't overwrite):

```markdown
## Week 3 — Complete

### What was built
- `agent_tool_permissions` table + assign/revoke/list, tenant-scoped,
  including Phase-2 stub columns (parameter_constraints,
  call_budget_per_hour) — present but explicitly unenforced this week
- Cross-tenant assignment guard, achieved by reusing Week 2's
  already-tenant-scoped agent/tool repository lookups rather than
  writing new guard logic
- checkPermission() returns a { granted, reason } object distinguishing
  policy denial from infrastructure failure; verifies agent.isActive,
  tool.isActive, AND tenant.deletedAt — not just the permission row's
  own flag — closing the mid-session deactivation/suspension gap at
  all three levels
- Rate limiter runs on its OWN dedicated ioredis connection
  (colocated inside rate-limiter.ts), separate from the shared client
  BullMQ depends on — avoided a real conflict between BullMQ's
  required maxRetriesPerRequest:null and the breaker's fast-fail
  maxRetriesPerRequest:1 on what would otherwise have been the same
  connection; wired into server.ts's graceful shutdown alongside it
- Atomic fixed-window rate limiter: Lua INCR+EXPIRE (proven atomic
  standalone against real Redis before anything depended on it),
  decision logic (evaluateRateLimit) kept as a pure TS function
- Concurrency proof: exactly 10/10 split under 20 simultaneous calls,
  limit=10, verified across repeated runs
- p95 latency for checkRateLimit measured against PRD §12's <5ms
  target (recorded: ___ ms, local Redis); checkPermission's latency
  also measured and recorded as a Week 6 baseline (recorded: ___ ms)
- Hybrid circuit breaker (CLOSED/OPEN/HALF_OPEN) wrapping
  checkRateLimit: bounded fail-open below a 3-failure threshold,
  fail-closed once tripped, probed back via a single HALF_OPEN call
  after a 15s cooldown — wired into the existing /health endpoint as
  an independent signal from the shared client's own health
- Documented explicitly (not just implemented): fail-closed on
  checkPermission errors vs. bounded fail-open on checkRateLimit
  errors is a deliberate asymmetry, not an inconsistency; the
  breaker's fail-open window is time-bounded, not call-count-bounded;
  concurrent HALF_OPEN probes resolve last-writer-wins
- prisma.ts's connection pool size explicitly set (AGENTGATE_DB_POOL_MAX,
  default 10) rather than left at an undecided default

### Proof checkpoint
- All five Week 3 gates pass: concurrency, cross-tenant isolation,
  tenant-suspension-blocks-immediately, agent-deactivation-blocks-
  immediately, breaker full-cycle
- Code review checklist complete, including carried-over items from
  Week 2 (ajv explicit dependency, toolRoutes registration) and the
  new Redis-client-separation checks

### Deferred (planned for later)
- Circuit breaker thresholds (failureThreshold=3, cooldownMs=15000)
  are hardcoded constants, not env-configurable — promote to env vars
  if operational tuning becomes necessary
- Granular permission-denial reasons are computed but not yet
  surfaced anywhere (M5's audit log, Week 5+, is where they'll
  actually get used)
- Redis-backed rate limiting is per-agent only; tenant-level and
  per-tool rate limits remain Phase 2 per PRD §5.5/§7
- A dedicated -32002 Service Degraded JSON-RPC code, and rejecting a
  suspended tenant's agents at SSE connect-time — both forward notes
  for Week 6, not this week's scope
- Week 8 deployment gate must include re-running the rate-limit
  latency bench against the actual deployed Redis instance, not just
  localhost — flagged explicitly here so it isn't silently skipped
- prisma.ts's pool size (10) is a reasoned starting point, not a
  load-tested number — revisit after Week 6's concurrency test and
  Week 8's 50-agent stress test
```

### Nice-to-haves not required for the Week 3 gate

- Making the breaker's thresholds env-configurable
- A dashboard-facing endpoint for current breaker state (beyond the `/health` tie-in) — not needed until M7's observability stream exists

---

## Week 3 Hours Summary

| Day | Focus | Target Hours |
|---|---|---|
| Day 1 | `agent_tool_permissions` schema + repository | 5h |
| Day 2 | Permission engine (checkPermission) + assign/revoke/list + latency bench | 5h |
| Day 3 | Dedicated rate-limiter Redis client + Lua script (proven standalone) | 5–6h |
| Day 4 | checkRateLimit wrapper + concurrency proof + latency bench | 5h |
| Day 5 | Hybrid circuit breaker (critical day) | 5–6h |
| Day 6 | Integration tests + official proof checkpoint + review | 5h |
| Day 7 | Buffer + prisma.ts pool fix + hardening + PROGRESS.md + Week 4 preview | 3–4h |
| **Total** | | **33–38h** |

Same flexibility note as Weeks 1 and 2: if you're doing 3–4h/day instead of 5–6h, stretch this to 10 days rather than compressing and skipping the Day 6 checkpoint. The checkpoint passing is what makes Week 4 — which will call `checkPermission` and `checkRateLimit` on every single tool invocation — safe to build on.

---

*Week 4 roadmap (Tool Execution Pipeline — M4) begins only after the Day 6 gate above passes — same rule as Weeks 1 and 2.*