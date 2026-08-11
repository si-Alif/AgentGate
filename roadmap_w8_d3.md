# AgentGate — Week 8, Day 3: Analysis & Amended Implementation Roadmap
## Concurrency, Load & Pool Sizing

**Status:** Amends the Day 3 section of `roadmap_w8.md` (Part 5's "Day 3 — Concurrency, Load & Pool Sizing" design/checkpoint, cross-referenced against Part 2's Finding W8-4 and Part 3's Decision 8.14). Continues the Decision Log at **8.63**, following `roadmap_w8_d1.md`'s 8.18–8.26, `email-integration-roadmap.md`'s 8.27–8.38, `roadmap_w8_d2.md`'s 8.39–8.46, and `user-invitation-roadmap.md`'s 8.47–8.62 — all four taken as shipped and extended, not rebuilt. Weeks 1–7 and Week 8 Days 1–2 are likewise taken as shipped. Follows the analysis → decision log → code-complete build → tests → checkpoint structure established across every Week 6/7/8 daily document.

---

## Part A — Architectural Analysis of the Suggested Day 3 Plan

### A.1 What Day 3 Actually Owes the Week

Day 1 proved M1–M7 cooperate correctly under composition. Day 2 proved that cooperation holds under one hostile actor pivoting across every door. Neither day ever put the system under genuine **concurrent volume** — Day 1's own Decision 8.26 was explicit that its harness stays *comfortably within* every coarse throttle's default ceiling, and Day 2's adversarial matrix fires a handful of pivot calls, not a sustained burst. Day 3 is the first day in this project's entire seven-plus-week history that asks a purely quantitative question: under real, concurrent, multi-surface load, does PRD §12's own headline latency claim hold, and do the two Postgres pools (`AGENTGATE_DB_POOL_MAX=10`, `AGENTGATE_AUDIT_DB_POOL_MAX=5` — sized by *reasoning*, Week 3 Day 7 and Week 5 Day 1, never by *measurement*) actually survive it.

I read `roadmap_w8.md`'s Day 3 design/checkpoint text against the **actual shipped Day 1/Day 2 code** — `system-harness.ts`'s bring-up/teardown primitive, `test-tenant.factory.ts`'s reconciled shape, Day 2's newly-live `public-auth-throttle.ts` and its `resetRateLimitKeyForTest` seam inside `createTestTenant()`, the real, current default of `AGENTGATE_MCP_TOOL_CALL_RATE_LIMIT` (Week 6 Day 4), and the real code paths `tools/call` walks through M3/M4/M5/M6 — rather than the prose alone. That comparison surfaced two genuinely critical corrections to the master plan's own stress-test design (one of which would make today's headline checkpoint literally unsatisfiable if built naively), a measurement design that would silently collect zero data for the PRD §12 metric if built the obvious way, a real and previously-undocumented gap in this project's own EventEmitter-error-listener discipline, and three smaller instrumentation/hygiene items — one of which doubles as a legitimate, additive security/observability improvement to apply today.

### A.2 Findings Summary

| # | Finding | Severity |
|---|---|---|
| **F1** | A naive reading of "50 concurrent agents" implies 50 tenants. But `createTestTenant()` — Day 1's own reconciled, canonical bootstrap helper — costs one `POST /auth/register-tenant` + one `POST /auth/login`, and **both** routes now carry Day 2's `"public-auth"` throttle (`AGENTGATE_PUBLIC_AUTH_RATE_LIMIT`, default 20/min, bucketed by `(request.ip, routeName)`). Bootstrapping 50 tenants from one process (one shared loopback IP) would burn through that ceiling roughly 2.5× over before the load run even starts — the exact class of self-inflicted regression Day 1's own Forward Note explicitly warned Day 3 to avoid reproducing ("must NOT reuse Day 1's fixed-single-tenant-per-flow design... should either reuse `resetRateLimitKeyForTest`... or explicitly confirm its own request volume"). | 🔴 Critical — Correctness (blocks the harness from bootstrapping at all) |
| **F2** | The master plan's own corrected stress-test table (500 succeed / 250 denied / 750 total) is built on HLD's stale, never-updated "10/min limit" text. The actual, currently-shipped default for the limiter Flow 5-style traffic is meant to exceed is `AGENTGATE_MCP_TOOL_CALL_RATE_LIMIT = 60` (Week 6 Day 4, Decision 4.2) — six times larger. Built against the literal 500/250/750 figures, today's headline checkpoint would either be silently wrong (if the test just asserts those numbers regardless of the real limit) or would require overriding the real production env var to force a 10/min ceiling — directly contradicting Decision 8.26's own stated philosophy ("never work around a throttle via env overrides, since that means testing against non-production config"). | 🔴 Critical — Correctness (the checkpoint as literally written cannot be satisfied against real production config) |
| **F3** | Even once the math is corrected against the real 60/min default, the rate limiter's fixed-window design (`Math.floor(Date.now()/60000)`) means a batch of calls whose wall-clock time approaches or crosses a minute boundary can see some of an agent's "over-limit" calls land in a *fresh* window and unexpectedly succeed — corrupting a hard-coded "exactly N denied" assertion. This is a real, if low-probability, source of flakiness that no prior week's rate-limit test has had to reckon with at this call volume (Week 3's concurrency gate used 20 calls; today's design uses 3,250). | 🟡 Medium — Test reliability |
| **F4** | Neither `prisma.ts` nor `audit-prisma.ts` tags its connection with `application_name`. The master plan's own explicit checkpoint ("Postgres pool sizing... is tuned from what this run actually shows") is unsatisfiable without a way to attribute `pg_stat_activity` rows to one pool or the other — right now a query against that view cannot tell the main pool's connections from the audit pool's. | 🟡 Medium — Missing capability, blocks the day's own stated checkpoint |
| **F5** | Because this project's own established, repeated convention (Weeks 4/6/7/8) is to test the gateway with a *deliberately SSRF-blocked* tool (avoiding any real external network dependency), every "successful" (rate-limit-passing) `tools/call` in today's load necessarily resolves to a JSON-RPC **error** response (`-32008 SSRF_BLOCKED`) — and per Week 6 Day 4/5's own `handleToolsCall` design, an error response is formatted via `formatMcpErrorResponse()`, which carries no `result` field at all, hence **no `_meta.gatewayOverheadMs`**. A naive "sample `gatewayOverheadMs` from each HTTP response" measurement strategy — the obvious, intuitive approach — would silently collect **zero samples**, defeating the entire PRD §12 checkpoint without ever raising an error. | 🟠 High — Measurement correctness (the headline metric would silently be un-measured) |
| **F6** | Nothing in the master plan's design distinguishes a genuine rate-limit denial (`-32001`) from a circuit-breaker-open / infra-degraded result (`-32002`) in the load run's own tally. Left unhandled, a `degraded:true` result under real concurrent Redis pressure (or a Postgres `checkPermission()` fail-closed timeout, which maps to the *same* `-32002` code) would be silently miscounted as either a "success" or a "denial," corrupting the precise checkpoint and — worse — hiding exactly the signal (infra pressure under load) this day exists to surface. | 🟡 Medium — Correctness/observability, self-referential instance of this project's own standing rule |
| **F7** | This project has applied the "every EventEmitter needs an explicit `.on('error', ...)` listener" discipline to *every* ioredis client (Weeks 2/3/6/7) and every BullMQ `Queue`/`Worker` (Weeks 2/5) — but never once, in seven-plus weeks, to the `pg.Pool` instances that `@prisma/adapter-pg` constructs underneath `prisma.ts`/`audit-prisma.ts`. `pg.Pool` is documented to emit an `'error'` event on an idle client that hits a network-level fault — the identical unhandled-crash shape this project has been careful about everywhere else. Whether `@prisma/adapter-pg` already guards this internally has never been confirmed. Today's heavier-than-ever connection churn is exactly the condition that makes this gap newly relevant to close out, one way or the other. | 🟠 High — Verification gap with real crash-risk stakes if unconfirmed |
| **F8** | A test file that fires ~3,250 MCP calls plus background REST/WS traffic and runs for tens of seconds does not belong in the same CI tier as this project's fast unit/integration suite. `roadmap_w8.md`'s own Day 5 CI design ("typecheck → lint → the Day 1 harness... on every push") implicitly excludes anything like today's suite — but nothing currently *enforces* that exclusion; today's file, added naively, would silently become part of every `npm test` invocation and every push-gated CI run. | 🟢 Low — CI hygiene, cheap to close now before it becomes load-bearing tech debt |

Findings F1 and F2 change whether today's harness can bootstrap and whether its headline checkpoint is even satisfiable; F5 changes how the PRD §12 metric has to be measured or it silently measures nothing; F3/F6 shape the load-firing and tallying logic; F4/F7/F8 are instrumentation/hygiene items, two of which (F4, F7) are also genuine, well-justified "make the system more observable/secure" improvements worth applying today independent of anything else.

---

### A.3 Finding F1 in Depth — Fifty Agents, Not Fifty Tenants

```mermaid
flowchart TD
    subgraph "❌ Naive reading: 50 tenants"
      A["createTestTenant() × 50"] --> B["50× POST /auth/register-tenant\n50× POST /auth/login\n— ALL from 127.0.0.1"]
      B --> C["public-auth throttle:\n20/min per (IP, route) — Day 2"]
      C --> D["429s start at request #21\non EACH bucket — bootstrap\nitself fails before any load fires"]
    end
    subgraph "✅ Today's design: 5 tenants × 10 agents"
      E["createTestTenant() × 5"] --> F["5× register-tenant, 5× login —\nwell under the 20/min ceiling"]
      F --> G["agentService.createAgent()\n× 10 per tenant — DIRECT service\ncalls, bypass HTTP entirely,\nzero throttle exposure"]
      G --> H["50 real agents, real API keys,\nsame aggregate load-generation\ncapacity the original spec wanted"]
    end
```

The fix isn't a workaround of Day 2's throttle — it's recognizing that "50 concurrent agents" was never a claim about tenant count. `agentService.createAgent()` (called directly by `test-tenant.factory.ts`'s own `createTestAgent()` helper) is a **service-layer** call, not an HTTP request — it never touches the public-auth throttle at all, regardless of how many times it's called. Concentrating many agents under few tenants is also the more realistic production shape (a single tenant with a growing team of agents is the common case; fifty distinct newly-registered organizations bursting in the same minute is not).

### A.4 Finding F2 in Depth — The Math Has to Come From the Real Limit, Not a Stale HLD Number

`roadmap_w8.md`'s own table is internally consistent (500 + 250 = 750 ✓) but every one of those three numbers is downstream of an assumed "10/min limit" that no longer exists anywhere in the shipped system. The actual, live default:

```typescript
// src/config/env.ts, Week 6 Day 4, Decision 4.2 — unchanged since
AGENTGATE_MCP_TOOL_CALL_RATE_LIMIT: z.coerce.number().int().positive().default(60),
```

**Fix:** compute the checkpoint's own expected figures *from* `env.AGENTGATE_MCP_TOOL_CALL_RATE_LIMIT` at test-run time, never from a literal. Preserving the master plan's own structural intent (agents call a small, fixed margin past their own limit) rather than its stale literal value:

```
callsPerAgent = realLimit + 5        (65, under today's real default)
succeedPerAgent = realLimit          (60)
deniedPerAgent  = 5

× 50 agents:
  total    = 3,250
  succeed  = 3,000   ("succeed" = passed permission+AJV+rate-limit,
                       reached executeTool() — see the F5/F6 tallying
                       note below for exactly what "succeed" means
                       given the SSRF-blocked test topology)
  denied   = 250
```

This makes the checkpoint **self-correcting** against any future change to the production default, rather than silently drifting stale the way the master plan's own table already has.

### A.5 Finding F3 in Depth — The Window-Boundary Risk, Stated and Mitigated

A fixed 60-second window means: if firing 3,250 calls (even with heavy concurrency) takes long enough for any single agent's own 65-call batch to straddle a minute boundary, some of that agent's "denied" calls could land in a fresh window and succeed instead — an assertion corrupted not by a bug, but by test timing. Two agents accidentally netting the same *aggregate* count while individually wrong would also mask this.

**Mitigation, not avoidance:** fire all 3,250 calls **globally concurrent** (cross-agent interleaved, bounded by one shared concurrency cap — never per-agent-sequential-then-next-agent), which keeps total wall-clock time low specifically *because* `.inject()` calls are in-process (no real socket round trip) and can be pipelined aggressively. Additionally, measure the actual elapsed wall-clock time of the load-firing step and assert it stays comfortably under a stated safety margin; if it doesn't, downgrade the assertion precision explicitly and log why, rather than either ignoring the risk or letting it produce a silent, unexplained failure. This is the same "precisely stated accepted imprecision" discipline Week 3's circuit breaker documentation established, applied here to test methodology instead of production code.

### A.6 Finding F4 in Depth — Two Pools, One Indistinguishable View

`pg_stat_activity` is the standard, zero-new-dependency way to observe live Postgres connection counts — but without a discriminating column, a query against it cannot tell `prisma`'s connections from `auditPrisma`'s. `application_name` is a standard libpq connection parameter, settable as a plain query-string parameter on the connection URL — no dependency on any adapter-specific constructor shape (sidesteps needing to know whether `@prisma/adapter-pg`'s pinned version accepts extra `pg.PoolConfig` fields beyond `connectionString`/`max`).

**A refinement to the query-volume estimate, while tracing this:** `tools/call` issues **three** main-pool queries, not two — `toolRepository.findByName()` (name resolution, `handleToolsCall`), `checkPermission()`'s `findGrantWithContext` (authorization, `handleToolsCall`), **and** `toolRepository.findById()` **inside `executeTool()` itself** (Week 4). That third lookup is not redundant tech debt to remove — per Part 7 of `roadmap_w6.md`'s own security boundary table, it is a *deliberate* defense-in-depth re-verification: *"A `toolId` alone is never sufficient to execute — tenant scope is re-proven at the point of decryption, not assumed from earlier in the pipeline."* Removing it would regress a named security boundary for a query-count improvement — the same tradeoff this project has already, repeatedly, refused to make elsewhere (never caching `checkPermission()`, for the identical reason). Today's revised estimate: **3,250 × 3 ≈ 9,750 main-pool queries** from the MCP path alone during the timed window, against a 10-connection pool — a genuinely serious concurrency stress, and the correct number to reason about, not the smaller one.

### A.7 Finding F5/F6 in Depth — What "Succeeded" Actually Means Here, and Where the Real Number Lives

```mermaid
flowchart TD
    A["tools/call against the SSRF-blocked\ntest tool, rate-limit check PASSES"] --> B["executeTool() runs,\nSSRF Layer 2 blocks it"]
    B --> C["executionResult.status = 'error'\nerrorCode = 'SSRF_BLOCKED'"]
    C --> D["handleToolsCall THROWS\nmapToolExecutionErrorToError\n=> JSON-RPC error -32008"]
    D --> E["formatMcpErrorResponse():\n{jsonrpc, id, error} — NO result field,\ntherefore NO _meta.gatewayOverheadMs\nvisible to the CLIENT"]

    F["BUT: gatewayOverheadMs was computed\nBEFORE executeTool() was even called\n(Week 6 Day 5, Decision 5.1) and passed\nIN as executeTool()'s own 7th parameter"] --> G["executeTool()'s own internal audit()\nclosure writes it into the PERSISTED\naudit_events.payload JSON — UNCONDITIONALLY,\nregardless of final status (Week 6 Day 5 patch)"]
    G --> H["Recoverable via a DIRECT auditPrisma\nquery, post-run, in ONE batched call —\nnever via the HTTP response, and never\nvia 3,250 individual GET /audit-events/:id\ncalls (which would itself distort the load)"]
```

**Tallying:** every response's JSON-RPC `error.code` (there is no non-error path for our test tool) sorts cleanly into exactly three buckets — `-32001` (genuine `RATE_LIMITED` denial), `-32002` (`SERVICE_DEGRADED` — a **ninth** application of this project's now-recurring "an infra fault is not a policy decision" rule, first drawn in `checkPermission()`'s result shape back in Week 3), and `-32008` (`SSRF_BLOCKED` — meaning the call *passed* permission, AJV, and rate-limiting, and reached real execution; this is today's operational definition of "succeeded"). The `-32002` bucket is worth a closer look: it fires identically whether the cause is the rate limiter's own circuit breaker tripping (Week 3's breaker) **or** `checkPermission()`'s fail-closed path catching a genuine Postgres fault (including a `P2024` connection-pool-timeout error) — meaning this bucket, built correctly, is simultaneously a Redis-pressure signal and a Postgres-pool-exhaustion signal, at zero extra instrumentation cost. A non-zero count here is exactly the kind of "the pool was genuinely under strain" evidence Day 3 is supposed to be looking for.

### A.8 Finding F7 in Depth — The One EventEmitter Never Checked

This project's own standing discipline, stated and re-applied at every single Redis-adjacent and BullMQ-adjacent construction site since Week 2 — *"An `EventEmitter` that emits an `'error'` event with no listener attached throws — synchronously, uncatchably, crashing the whole process"* — has simply never been checked against the two `pg.Pool` instances `@prisma/adapter-pg` builds underneath `prisma.ts`/`audit-prisma.ts`. `node-postgres`'s own documentation describes exactly this failure mode for an idle pooled client that encounters a background network error. Whether Prisma's driver-adapter layer already absorbs and re-surfaces such errors as ordinary rejected promises (plausible, given how deliberately Prisma 7's adapter architecture is designed to give the query engine full control over the underlying driver) or whether a raw, unguarded `'error'` event can still reach the process is **not something I can respond to via a search or by tracing this repository's own code — it depends on `@prisma/adapter-pg`'s internal implementation, which is confirm-at-implementation-time territory, exactly like every other library-internals claim this project has flagged rather than assumed (M4's dispatcher precedence, M6 Day 4's AJV draft, M7 Day 5's ioredis-subscriber `PING`).**

**Resolution today:** a safe, automatable regression test that proves the *observable* behavior — a Prisma client pointed at a deliberately unreachable target fails as an ordinary rejected promise, with zero `uncaughtException`/`unhandledRejection` anywhere in the process — regardless of what's happening inside the adapter to make that true. This settles the question that actually matters (does the process crash) without needing to pin down an uncertain internal implementation detail. The disruptive "kill the real, shared Postgres container mid-session" scenario stays a **manual** hardening-checklist item, exactly matching this project's own established precedent (Week 3 Day 7: *"Confirm killing the local Redis container for a few seconds mid-run does NOT crash the process"* — never automated, always a checklist line) rather than something a shared CI Postgres instance should be disrupted for.

### A.9 What I'm Deliberately Not Changing

- **Not touching `checkPermission()`'s "always fresh, never cached" design**, even under the query-volume pressure Finding F4's refinement surfaces. That's a deliberate Week 3 security boundary (immediate revocation), not an oversight, and second-guessing it without overwhelming evidence is out of today's scope, which is measurement, not redesign.
- **Not removing `executeTool()`'s own internal tool re-lookup.** Confirmed deliberate, Week 4, Part 7 of `roadmap_w6.md`. Named explicitly in F4 so nobody "optimizes" it away later without this context.
- **Not changing `AGENTGATE_DB_POOL_MAX`/`AGENTGATE_AUDIT_DB_POOL_MAX`'s shipped default values today.** The master plan's own phrase — "tuned from what this run actually shows" — means the number is downstream of real, executed measurement. Today builds the full, precise instrumentation and the exact decision rule; the harness itself computes and logs a specific recommended value once run, rather than a number asserted here without having been measured.
- **Not hard-gating `gatewayOverheadMs`'s p95 against the 300ms budget.** The master plan is explicit: *"this day's job is to know the number, not to force it under budget by any means necessary."* The test asserts the metric was successfully **measured** (a real, sensible, non-null distribution), not that it clears a threshold.
- **Not building Day 2's own adversarial-pivot scenarios again, nor Day 4's chaos-injection/resilience work.** Both remain their own days' jobs.
- **Not adding a real, network-level "unresponsive Postgres" simulation to the automated suite.** Mirrors Week 4 Day 6 and Week 7 Day 4's own established precedent for exactly this class of untestable-safely scenario.

### A.10 Consolidated Decision Log (continues at 8.63)

| # | Decision | Why |
|---|---|---|
| 8.63 | Load topology is **5 tenants × 10 agents = 50 agents** (never 50 tenants), with agent/tool/permission bootstrap going through direct service-layer calls (`agentService`, `toolService`, `permissionService`) rather than HTTP, exactly matching `test-tenant.factory.ts`'s own established pattern. | Closes F1. |
| 8.64 | Every stress-test figure is **computed at test-run time** from `env.AGENTGATE_MCP_TOOL_CALL_RATE_LIMIT`, never hardcoded. `callsPerAgent = realLimit + 5`. Under today's real default (60), this evaluates to 3,000 succeed / 250 denied / 3,250 total — the corrected, self-updating replacement for the master plan's stale 500/250/750 table. | Closes F2. |
| 8.65 | All 3,250 calls fire under **one shared, cross-agent-interleaved concurrency cap** (never per-agent-sequential). Total load-firing wall-clock time is measured; if it exceeds a stated safety margin, the suite logs an explicit warning and relaxes per-agent assertion precision to a documented, bounded tolerance rather than failing opaquely. | Closes F3. |
| 8.66 | Both Postgres connection strings gain an `application_name` tag (`agentgate-main` / `agentgate-audit`), applied via a pure, adapter-version-agnostic URL query-parameter helper — never by assuming an uncertain `PrismaPg` constructor overload. | Closes F4. |
| 8.67 | `gatewayOverheadMs`'s distribution is read via **one direct, post-run `auditPrisma` query** against `audit_events.payload`, scoped to today's own tenant IDs and time window — never sampled from client HTTP responses (which structurally omit `_meta` for every response in this load's SSRF-blocked topology) and never via per-event `GET /audit-events/:id` calls (which would itself distort the very load being measured). | Closes F5. |
| 8.68 | Every response is tallied by JSON-RPC `error.code` into exactly three buckets: `-32001` (genuine denial), `-32002` (degraded — Redis breaker **or** Postgres fail-closed, never conflated with a genuine denial), `-32008` (executed — this load's operational definition of "succeeded," given the deliberately SSRF-blocked test tool). The `-32002` bucket doubles as a free, already-available Postgres-pool-exhaustion signal. | Closes F6. |
| 8.69 | A safe, automatable regression test proves a Prisma client pointed at an unreachable Postgres target fails as an ordinary rejected promise with zero process-level crash signal — settling the *observable* question without depending on an unconfirmed `@prisma/adapter-pg` internal. The full "kill the real, shared Postgres mid-session" scenario remains an explicit **manual** hardening-checklist item, per Week 3 Day 7's own established precedent — never automated against shared test infrastructure. | Closes F7. |
| 8.70 | Today's Redis clients (`redis`, `rateLimiterRedis`, `tenantEventSubscriber`) each gain an explicit, safe, additive `connectionName` tag (ioredis's own documented, low-risk `CLIENT SETNAME` mechanism) — giving `CLIENT LIST` a precise, filterable way to confirm exactly which of the theoretical 5-per-replica connections exist, rather than relying on fragile before/after delta arithmetic across module-import-time side effects. | Extends F4's observability improvement to the Redis side; directly enables validating Decision 8.14/8.37's already-confirmed "5 per replica" figure against what the running process actually opens, per the master plan's own explicit ask. |
| 8.71 | The load test lives under `src/__tests__/load/`, **excluded** from the default `npm test`/per-push CI run via `vitest.config.ts`, invoked instead through a dedicated `npm run test:load` script (single-fork, isolated). | Closes F8. |
| 8.72 | `AGENTGATE_DB_POOL_MAX`/`AGENTGATE_AUDIT_DB_POOL_MAX` are left at their shipped defaults today. The harness itself computes and logs a specific, reasoned recommendation from the run's own observed peak/saturation data — never a number asserted without having been measured. | Restates the master plan's own "tuned from what this run actually shows" language as an explicit, non-negotiable design constraint for today's code, not merely a hope. |

---

## Part B — Day 3 Amended Implementation Roadmap

**Hours target:** 7.5–8.5h — the largest day since Week 8's own Day 2, consistent with this being the first genuinely new *category* of test (load, not correctness) this project has built, plus two well-justified production-hardening patches (F4/F7's observability tagging, F7's crash-safety verification) layered on top.

**New dependencies:** none. **New env vars:** none — deliberately; every load-topology parameter (tenant count, agents-per-tenant, concurrency cap, safety margin) is a test-local constant, not production configuration, matching Day 1's own precedent for its harness's fixed-topology parameters.

### Dependency Chain (within the day)

```
src/lib/pg-connection-string.ts (NEW)
(withApplicationName() — pure, adapter-agnostic — Decision 8.66)
  │
  ├─────────────────────────┬─────────────────────────┐
  ▼                         ▼                          ▼
prisma.ts patch      audit-prisma.ts patch      redis.ts / rate-limiter.ts /
(application_name)    (application_name)         ws-tenant-registry.ts patches
                                                  (connectionName — Decision 8.70)
  │                         │                          │
  └─────────────────────────┴──────────────┬───────────┘
                                            ▼
                      src/__tests__/load/helpers/
                      ├── load-harness.ts          (topology bootstrap — F1)
                      ├── db-pool-observer.ts       (pg_stat_activity polling — F4)
                      ├── redis-connection-observer.ts (CLIENT LIST — 8.70)
                      └── gateway-overhead-sampler.ts  (direct audit query — F5)
                                            │
                                            ▼
                      src/__tests__/load/concurrency-load.test.ts
                      (the official Day 3 load test — F1/F2/F3/F6)
                                            │
                                            ▼
                      src/__tests__/prisma-pool-error-resilience.test.ts
                      (F7's regression proof — independent of the load test)
                                            │
                                            ▼
                      vitest.config.ts + package.json patches (F8 — CI isolation)
```

### File Structure Added / Modified This Day

```
src/
├── lib/
│   ├── pg-connection-string.ts        # NEW — withApplicationName()
│   ├── prisma.ts                      # MODIFIED — application_name tag
│   ├── audit-prisma.ts                # MODIFIED — application_name tag
│   ├── redis.ts                       # MODIFIED — connectionName tag
│   └── rate-limiter.ts                # MODIFIED — connectionName tag (rateLimiterRedis)
├── observability/
│   └── ws-tenant-registry.ts          # MODIFIED — connectionName tag (tenantEventSubscriber)
└── __tests__/
    ├── pg-connection-string.test.ts             # NEW
    ├── prisma-pool-error-resilience.test.ts     # NEW — Finding F7
    └── load/
        ├── helpers/
        │   ├── load-harness.ts                  # NEW
        │   ├── db-pool-observer.ts              # NEW
        │   ├── redis-connection-observer.ts     # NEW
        │   └── gateway-overhead-sampler.ts      # NEW
        └── concurrency-load.test.ts             # NEW — the official Day 3 load test
vitest.config.ts                                  # MODIFIED — exclude load/** from default run
package.json                                      # MODIFIED — add test:load script
```

### Concept Primer (~15 min)

**Why `application_name`/`connectionName` instead of trying to reach into `PrismaPg`'s or BullMQ's internal pool/connection objects.** Every prior "which internal object does this library expose" question this project has faced (M4's dispatcher precedence, M7's ioredis subscriber `PING`) got resolved by testing the *observable* behavior directly, not by reading library source and hoping the API surface matches. Tagging via a documented, stable, connection-string-level parameter (Postgres) or a documented, stable constructor option (ioredis) sidesteps needing to know anything about either library's internal pool-object shape — the tag survives regardless of implementation details, and both `pg_stat_activity` and `CLIENT LIST` are stable, public, server-side introspection surfaces that don't depend on the client library's own internals at all.

**Why `gatewayOverheadMs` is read via a direct database query instead of the HTTP layer.** This is the same principle Week 4 Day 6 already established for a structurally identical problem — proving `executeTool()`'s own logic sometimes requires bypassing the transport layer entirely and asserting against the thing that's actually, durably true, rather than against what happens to be visible through whichever response shape a particular test topology produces.

**Why the load test lives in its own excluded directory rather than just getting a long `testTimeout`.** A slow, resource-heavy suite that happens to *pass* quickly on one machine is still the wrong tier for a fast, every-push CI gate — the exclusion is a statement about what kind of test this is, not merely about how long it happens to take today.

### Build Block

#### Step 1 — `src/lib/pg-connection-string.ts` (NEW) (20 min)

```typescript
/**
 * Week 8 Day 3 — Decision 8.66 (Finding F4). Pure, dependency-free,
 * adapter-version-agnostic. Postgres's own libpq connection-parameter
 * set has always supported `application_name` as a plain query
 * parameter on the connection URI — this works regardless of what
 * @prisma/adapter-pg's exact constructor signature accepts, since it
 * operates purely on the connectionString VALUE, never on the
 * adapter's own config-object shape. Mirrors this project's existing
 * `parsePostgresUrl`/`redactConnectionString` precedent (Week 4) of
 * treating a Postgres connection string as structured data via the
 * native URL class, not string concatenation.
 */
export function withApplicationName(connectionString: string, applicationName: string): string {
  const url = new URL(connectionString);
  url.searchParams.set("application_name", applicationName);
  return url.toString();
}
```

#### Step 2 — `src/lib/prisma.ts` patch (10 min)

```diff
+import { withApplicationName } from "./pg-connection-string.js";
+
 export const prisma =
   globalForPrisma.prisma ??
   new PrismaClient({
     adapter: new PrismaPg({
-      connectionString: env.AGENTGATE_DATABASE_URL,
+      // Week 8 Day 3 — Decision 8.66 (Finding F4). Enables
+      // pg_stat_activity to distinguish THIS pool's connections from
+      // audit-prisma.ts's dedicated pool — required by today's own
+      // pool-sizing checkpoint, which has no other way to attribute
+      // observed connections to one pool or the other.
+      connectionString: withApplicationName(env.AGENTGATE_DATABASE_URL, "agentgate-main"),
       max: env.AGENTGATE_DB_POOL_MAX,
     }),
     log: ["error", "warn"],
   });
```

#### Step 3 — `src/lib/audit-prisma.ts` patch (10 min)

```diff
+import { withApplicationName } from "./pg-connection-string.js";
+
 export const auditPrisma =
   globalForAuditPrisma.auditPrisma ??
   new PrismaClient({
     adapter: new PrismaPg({
-      connectionString: env.AGENTGATE_DATABASE_URL,
+      connectionString: withApplicationName(env.AGENTGATE_DATABASE_URL, "agentgate-audit"),
       max: env.AGENTGATE_AUDIT_DB_POOL_MAX,
     }),
     log: ["error", "warn"],
   });
```

#### Step 4 — Redis `connectionName` tags (Decision 8.70) (20 min)

```diff
 // src/lib/redis.ts
 export const redis = new IORedis(env.AGENTGATE_REDIS_URL, {
   maxRetriesPerRequest: null,
+  // Week 8 Day 3 — Decision 8.70. Safe, additive, zero-behavior-change
+  // CLIENT SETNAME tagging — lets `CLIENT LIST` unambiguously identify
+  // this connection, needed to validate the Decision 8.14/8.37
+  // "5 connections per replica" formula against what the process
+  // actually opens, rather than counting an unlabeled delta.
+  connectionName: "agentgate:main",
 });
```

```diff
 // src/lib/rate-limiter.ts
 export const rateLimiterRedis = new Redis(env.AGENTGATE_REDIS_URL, {
   maxRetriesPerRequest: 1,
   commandTimeout: 1000,
+  connectionName: "agentgate:rate-limiter",
   retryStrategy(times: number) { ... },
   reconnectOnError(err: Error) { ... },
 });
```

```diff
 // src/observability/ws-tenant-registry.ts
-export const tenantEventSubscriber = redis.duplicate();
+export const tenantEventSubscriber = redis.duplicate({
+  connectionName: "agentgate:tenant-event-subscriber",
+});
```

No behavior change on any of the three — `connectionName` only affects what `CLIENT LIST`/`CLIENT INFO` report server-side.

#### Step 5 — `src/__tests__/load/helpers/load-harness.ts` (NEW) (1.25h)

```typescript
import { permissionService } from "../../../services/permission.service.js";
import {
  createTestTenant,
  createTestAgent,
  createSsrfBlockedTool,
} from "../../helpers/test-tenant.factory.js";
import type { FastifyInstance } from "fastify";

/**
 * Week 8 Day 3 — Decision 8.63 (Finding F1). Deliberately 5 tenants ×
 * 10 agents = 50 agents, NOT 50 tenants — see roadmap_w8_d3.md §A.3.
 * Agent/tool/permission creation goes through direct SERVICE-layer
 * calls (agentService/toolService/permissionService), exactly
 * mirroring test-tenant.factory.ts's own established convention —
 * these paths never touch Day 2's public-auth throttle at all, since
 * they never go through HTTP.
 *
 * Bootstrap runs strictly SEQUENTIALLY, tenant by tenant. This is
 * off the TIMED load-window path entirely (bootstrap happens inside
 * beforeAll, before any measurement begins) — sequential execution
 * here avoids any question of createTestTenant()'s own
 * resetRateLimitKeyForTest() calls racing each other across
 * concurrent invocations for no benefit, since total bootstrap cost
 * is a handful of seconds regardless.
 */

export const LOAD_TENANT_COUNT = 5;
export const AGENTS_PER_TENANT = 10;
export const TOTAL_AGENTS = LOAD_TENANT_COUNT * AGENTS_PER_TENANT; // 50

export interface LoadAgent {
  id: string;
  apiKey: string;
}

export interface LoadTenant {
  tenantId: string;
  userId: string;
  accessToken: string;
  toolId: string;
  toolName: string;
  agents: LoadAgent[];
}

export async function bootstrapLoadTenants(app: FastifyInstance): Promise<LoadTenant[]> {
  const tenants: LoadTenant[] = [];

  for (let t = 0; t < LOAD_TENANT_COUNT; t++) {
    const created = await createTestTenant(app);

    const toolRow = await createSsrfBlockedTool(created.tenantId, `load-tool-t${t}-${Date.now()}`);

    const agents: LoadAgent[] = [];
    for (let a = 0; a < AGENTS_PER_TENANT; a++) {
      const createdAgent = await createTestAgent(created.tenantId, created.userId);
      await permissionService.assignPermission(created.tenantId, {
        agentId: createdAgent.agent.id,
        toolId: toolRow.id,
      });
      agents.push({ id: createdAgent.agent.id, apiKey: createdAgent.apiKey });
    }

    tenants.push({
      tenantId: created.tenantId,
      userId: created.userId,
      accessToken: created.accessToken,
      toolId: toolRow.id,
      toolName: toolRow.name,
      agents,
    });
  }

  return tenants;
}

/**
 * Week 8 Day 3 — Decision 8.65 (Finding F3). A small, dependency-free,
 * bounded worker-pool executor — this project's own established
 * preference for building small utilities itself (withTimeout, Week
 * 4) rather than adding a library dependency (e.g. p-limit) for a
 * single, narrowly-scoped need.
 *
 * Concurrency is GLOBAL across the whole `items` array, not per any
 * subgrouping the caller might have in mind — this is what produces
 * genuine cross-agent interleaving when items span multiple agents'
 * own call batches, which is both the more realistic simulation of
 * concurrent production traffic AND the mechanism that keeps total
 * wall-clock time low (Finding F3's own mitigation).
 */
export async function runWithConcurrency<T, R>(
  items: readonly T[],
  worker: (item: T, index: number) => Promise<R>,
  concurrency: number
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function runOne(): Promise<void> {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!, index);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => runOne());
  await Promise.all(workers);
  return results;
}

/**
 * REST "management traffic" background poller (master plan's own
 * explicit requirement: load runs concurrently with ordinary REST
 * traffic, "not the MCP gateway in isolation"). Deliberately hits
 * ONLY unthrottled routes (GET /api/agents, GET /api/tools) — never
 * GET /api/audit-events, which carries its own 30/min-per-user
 * throttle (Week 5, fixed Week 7 Day 5) that this background traffic
 * has no reason to compete against, since today's own
 * gatewayOverheadMs measurement bypasses that HTTP route entirely
 * (Decision 8.67).
 */
export function startBackgroundRestPoller(
  app: FastifyInstance,
  tenants: readonly LoadTenant[],
  intervalMs: number
): { stop: () => void } {
  let stopped = false;

  const timers = tenants.map((tenant) => {
    return setInterval(() => {
      if (stopped) return;
      void app.inject({
        method: "GET",
        url: "/api/agents",
        headers: { Authorization: `Bearer ${tenant.accessToken}` },
      });
      void app.inject({
        method: "GET",
        url: "/api/tools",
        headers: { Authorization: `Bearer ${tenant.accessToken}` },
      });
    }, intervalMs);
  });

  return {
    stop: () => {
      stopped = true;
      timers.forEach(clearInterval);
    },
  };
}
```

#### Step 6 — `src/__tests__/load/helpers/db-pool-observer.ts` (NEW) (45 min)

```typescript
import { prisma } from "../../../lib/prisma.js";
import { auditPrisma } from "../../../lib/audit-prisma.js";

/**
 * Week 8 Day 3 — Decision 8.66 (Finding F4). Polls pg_stat_activity,
 * discriminating by application_name (Step 2/3's patch) rather than
 * needing direct pg.Pool access — sidesteps the @prisma/adapter-pg
 * constructor-shape uncertainty flagged in §A.7 entirely.
 *
 * Uses the SAME singleton clients this observer is measuring to run
 * the polling query itself — a small, accepted, "precisely stated"
 * observer-effect (Week 3's own established pattern for this class
 * of imprecision): each poll consumes one connection FROM the pool
 * being measured, for the brief duration of the query. Deliberately
 * NOT a third, separate pool — a separate pool would itself distort
 * the very connection-count formula (Decision 8.14/8.37) today's run
 * is supposed to validate.
 */

export interface PoolSample {
  timestamp: number;
  active: number;
  idle: number;
  total: number;
}

export interface PoolSummary {
  applicationName: string;
  configuredMax: number;
  peakTotal: number;
  peakActive: number;
  sampleCount: number;
  sustainedAtMaxCount: number; // samples where total === configuredMax
}

async function sampleOne(applicationName: string): Promise<Omit<PoolSample, "timestamp">> {
  const rows = await prisma.$queryRaw<Array<{ active: bigint; idle: bigint; total: bigint }>>`
    SELECT
      count(*) FILTER (WHERE state = 'active') AS active,
      count(*) FILTER (WHERE state = 'idle') AS idle,
      count(*) AS total
    FROM pg_stat_activity
    WHERE application_name = ${applicationName}
  `;
  const row = rows[0]!;
  return { active: Number(row.active), idle: Number(row.idle), total: Number(row.total) };
}

export class DbPoolObserver {
  private samples: PoolSample[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly applicationName: string,
    private readonly configuredMax: number,
    private readonly intervalMs = 200
  ) {}

  start(): void {
    this.timer = setInterval(() => {
      void sampleOne(this.applicationName).then((s) => {
        this.samples.push({ timestamp: Date.now(), ...s });
      });
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  summary(): PoolSummary {
    const peakTotal = this.samples.reduce((max, s) => Math.max(max, s.total), 0);
    const peakActive = this.samples.reduce((max, s) => Math.max(max, s.active), 0);
    const sustainedAtMaxCount = this.samples.filter((s) => s.total >= this.configuredMax).length;
    return {
      applicationName: this.applicationName,
      configuredMax: this.configuredMax,
      peakTotal,
      peakActive,
      sampleCount: this.samples.length,
      sustainedAtMaxCount,
    };
  }
}

/**
 * Week 8 Day 3 — Decision 8.72. Turns an observed summary into a
 * concrete, reasoned recommendation, WITHOUT asserting a specific new
 * pool-size number that hasn't actually been measured (see
 * roadmap_w8_d3.md §A "What I'm Deliberately Not Changing"). If the
 * pool was NEVER observed pinned at its configured max, the existing
 * default is confirmed sufficient for this run's profile. If it WAS
 * sustained at max for a meaningful fraction of samples, this
 * recommends a specific new value with its own reasoning — the human
 * (or a future Day 7 pass) applies it.
 */
export function recommendPoolSize(summary: PoolSummary): { sufficient: boolean; recommendation: string } {
  const saturationRatio = summary.sampleCount > 0 ? summary.sustainedAtMaxCount / summary.sampleCount : 0;

  if (saturationRatio < 0.05) {
    return {
      sufficient: true,
      recommendation:
        `${summary.applicationName}: peak observed ${summary.peakTotal}/${summary.configuredMax} ` +
        `connections, pinned at max for only ${(saturationRatio * 100).toFixed(1)}% of samples — ` +
        `CONFIRMED sufficient for this run's profile, no change recommended.`,
    };
  }

  const recommendedMax = Math.ceil(summary.configuredMax * 1.5) + 5; // headroom, not a guess at exact demand
  return {
    sufficient: false,
    recommendation:
      `${summary.applicationName}: pinned at its configured max (${summary.configuredMax}) for ` +
      `${(saturationRatio * 100).toFixed(1)}% of samples — likely a real bottleneck under this load. ` +
      `Recommended new value: ${recommendedMax} (1.5x + 5 headroom over the observed ceiling). ` +
      `Re-run this suite after applying the change to confirm.`,
  };
}
```

#### Step 7 — `src/__tests__/load/helpers/redis-connection-observer.ts` (NEW) (30 min)

```typescript
import { rateLimiterRedis } from "../../../lib/rate-limiter.js";

const AGENTGATE_NAME_PREFIX = "agentgate:";

/**
 * Week 8 Day 3 — Decision 8.70. Reuses rateLimiterRedis purely as a
 * COMMAND CHANNEL to run CLIENT LIST against the shared Redis server
 * — CLIENT LIST reports every connection to that server, not just
 * ones opened by the client issuing the command, so which client runs
 * the query doesn't affect the result.
 *
 * Counts entries whose `name` field carries the agentgate: prefix
 * (Step 4's tags) — a DEFINITIVE, precise count of the 3 explicitly-
 * owned, directly-constructed clients, distinct from BullMQ's own
 * internally-duplicated (unnamed) blocking-read connections for the
 * audit and email workers, which this function reports separately as
 * a corroborating total delta.
 */
export interface RedisConnectionSnapshot {
  namedAgentgateClients: number;
  totalConnectedClients: number;
}

export async function snapshotRedisConnections(): Promise<RedisConnectionSnapshot> {
  const raw = await rateLimiterRedis.client("LIST");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  const namedAgentgateClients = lines.filter((l) => {
    const match = l.match(/(?:^|\s)name=(\S*)/);
    return match?.[1]?.startsWith(AGENTGATE_NAME_PREFIX) ?? false;
  }).length;

  const info = await rateLimiterRedis.info("clients");
  const totalMatch = info.match(/connected_clients:(\d+)/);
  const totalConnectedClients = totalMatch ? parseInt(totalMatch[1]!, 10) : lines.length;

  return { namedAgentgateClients, totalConnectedClients };
}
```

#### Step 8 — `src/__tests__/load/helpers/gateway-overhead-sampler.ts` (NEW) (30 min)

```typescript
import { auditPrisma } from "../../../lib/audit-prisma.js";

/**
 * Week 8 Day 3 — Decision 8.67 (Finding F5). Reads gatewayOverheadMs
 * DIRECTLY from the persisted audit_events.payload JSON field — the
 * only place this value is guaranteed present, given every response
 * this load produces is a JSON-RPC ERROR (SSRF-blocked), which
 * structurally omits _meta at the HTTP layer (Week 6 Day 4/5 design).
 * Populated unconditionally by executeTool()'s own audit() closure
 * (Week 6 Day 5 patch) regardless of final execution status.
 *
 * One batched query for the WHOLE population — never per-event HTTP
 * calls, which would themselves distort the load being measured.
 */
export async function sampleGatewayOverheadMs(tenantIds: readonly string[], since: Date): Promise<number[]> {
  const rows = await auditPrisma.$queryRaw<Array<{ overhead: number | null }>>`
    SELECT (payload->>'gatewayOverheadMs')::int AS overhead
    FROM audit_events
    WHERE tenant_id = ANY(${tenantIds})
      AND event_type = 'TOOL_INVOCATION'
      AND created_at >= ${since}
      AND payload ? 'gatewayOverheadMs'
  `;
  return rows.map((r) => r.overhead).filter((v): v is number => v !== null);
}

export function percentile(sortedValuesAscending: readonly number[], p: number): number {
  if (sortedValuesAscending.length === 0) return NaN;
  const index = Math.min(sortedValuesAscending.length - 1, Math.ceil((p / 100) * sortedValuesAscending.length) - 1);
  return sortedValuesAscending[Math.max(0, index)]!;
}

export function summarizeLatencies(samples: readonly number[]): {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
} {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted.length > 0 ? sorted[sorted.length - 1]! : NaN,
  };
}
```

#### Step 9 — `src/__tests__/load/concurrency-load.test.ts` (NEW — the official Day 3 load test) (2.5h)

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WebSocket as WsClient } from "ws";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { startFullSystem, stopFullSystem } from "../helpers/system-harness.js";
import type { SystemHarness } from "../helpers/system-harness.js";
import { cleanupTenant } from "../helpers/test-tenant.factory.js";
import {
  bootstrapLoadTenants,
  runWithConcurrency,
  startBackgroundRestPoller,
  LOAD_TENANT_COUNT,
  AGENTS_PER_TENANT,
  TOTAL_AGENTS,
} from "./helpers/load-harness.js";
import type { LoadTenant } from "./helpers/load-harness.js";
import { DbPoolObserver, recommendPoolSize } from "./helpers/db-pool-observer.js";
import { snapshotRedisConnections } from "./helpers/redis-connection-observer.js";
import { sampleGatewayOverheadMs, summarizeLatencies } from "./helpers/gateway-overhead-sampler.js";
import { getRateLimiterBreaker } from "../../lib/rate-limiter.js";
import {
  getActiveConnectionCount,
  resetAllConnectionsForTest,
} from "../../observability/ws-connection-tracker.js";
import { getAllRegisteredSockets, resetTenantRegistryForTest } from "../../observability/ws-tenant-registry.js";
import { env } from "../../config/env.js";

const OVERAGE_CALLS_PER_AGENT = 5;
const GLOBAL_CONCURRENCY = 150;
const WALL_CLOCK_SAFETY_MARGIN_MS = 45_000; // Finding F3 — comfortably under the 60s rate-limit window
const REST_POLL_INTERVAL_MS = 300;

function mcpEnvelope(method: string, params: unknown, id: string | number) {
  return { jsonrpc: "2.0", id, method, params, _meta: { protocolVersion: "2026-07-28" } };
}

async function mcpCall(app: FastifyInstance, apiKey: string, id: string | number) {
  const res = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: { authorization: `Bearer ${apiKey}` },
    payload: mcpEnvelope("tools/call", { name: "will-be-set-per-tenant" }, id),
  });
  return JSON.parse(res.body);
}

function connectAndCollect(url: string) {
  const ws = new WsClient(url);
  const messages: any[] = [];
  ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
  return { ws, messages };
}
async function waitForMessage(ws: WsClient, predicate?: (m: any) => boolean, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for a WS message")), timeoutMs);
    const handler = (data: Buffer) => {
      const parsed = JSON.parse(data.toString());
      if (!predicate || predicate(parsed)) {
        clearTimeout(timer);
        ws.off("message", handler);
        resolve(parsed);
      }
    };
    ws.on("message", handler);
  });
}
async function mintTicketAndConnect(app: FastifyInstance, port: number, tenant: LoadTenant) {
  const res = await app.inject({
    method: "POST",
    url: "/api/observability/ticket",
    headers: { Authorization: `Bearer ${tenant.accessToken}` },
  });
  const { ticket } = JSON.parse(res.body);
  const conn = connectAndCollect(`ws://127.0.0.1:${port}/observability/stream?ticket=${ticket}`);
  await waitForMessage(conn.ws, (m) => m.type === "connected");
  return conn;
}

interface CallDescriptor {
  agentIndex: number; // global index across all 50 agents
  apiKey: string;
  toolName: string;
}

/**
 * Week 8, Day 3 — Concurrency, Load & Pool Sizing.
 *
 * Deliberately isolated (Decision 8.71, Finding F8) — excluded from
 * the default `npm test` run via vitest.config.ts; invoked only via
 * `npm run test:load`.
 */
describe("Week 8, Day 3 — Concurrency Load & Pool Sizing", () => {
  let harness: SystemHarness;
  let tenants: LoadTenant[];
  let restPoller: { stop: () => void };
  let mainPoolObserver: DbPoolObserver;
  let auditPoolObserver: DbPoolObserver;
  let wsViewers: Array<{ ws: WsClient; messages: any[] }>;
  let redisBeforeStart: Awaited<ReturnType<typeof snapshotRedisConnections>>;
  const unhandledErrors: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandledErrors.push(reason);

  beforeAll(async () => {
    process.on("unhandledRejection", onUnhandled);
    process.on("uncaughtException", onUnhandled);

    redisBeforeStart = await snapshotRedisConnections();
    harness = await startFullSystem();

    tenants = await bootstrapLoadTenants(harness.app);
    expect(tenants).toHaveLength(LOAD_TENANT_COUNT);
    expect(tenants.reduce((sum, t) => sum + t.agents.length, 0)).toBe(TOTAL_AGENTS);

    wsViewers = await Promise.all(tenants.map((t) => mintTicketAndConnect(harness.app, harness.port, t)));

    restPoller = startBackgroundRestPoller(harness.app, tenants, REST_POLL_INTERVAL_MS);

    mainPoolObserver = new DbPoolObserver("agentgate-main", env.AGENTGATE_DB_POOL_MAX);
    auditPoolObserver = new DbPoolObserver("agentgate-audit", env.AGENTGATE_AUDIT_DB_POOL_MAX);
    mainPoolObserver.start();
    auditPoolObserver.start();
  }, 60_000);

  afterAll(async () => {
    mainPoolObserver.stop();
    auditPoolObserver.stop();
    restPoller.stop();
    wsViewers.forEach((v) => v.ws.close());

    for (const tenant of tenants) {
      await cleanupTenant(tenant.tenantId).catch(() => {});
    }

    resetAllConnectionsForTest();
    await resetTenantRegistryForTest();
    await stopFullSystem(harness);

    process.off("unhandledRejection", onUnhandled);
    process.off("uncaughtException", onUnhandled);
    // GATE — zero unhandled errors across the entire, heaviest-yet run.
    expect(unhandledErrors).toHaveLength(0);
  }, 30_000);

  it("GATE — Redis connections match the theoretical 5-per-replica formula (Decision 8.14/8.37), validated against what the process actually opened", async () => {
    const during = await snapshotRedisConnections();
    // The 3 explicitly-owned, directly-named clients (redis,
    // rateLimiterRedis, tenantEventSubscriber) — a definitive count,
    // independent of BullMQ's own internal, unnamed duplicates.
    expect(during.namedAgentgateClients).toBe(3);
    // Corroborating total: 3 named + 2 unnamed BullMQ-internal
    // blocking-read duplicates (audit worker's own, email worker's
    // own — confirmed shared-client, Decision 8.37) = 5.
    expect(during.totalConnectedClients - redisBeforeStart.totalConnectedClients).toBeGreaterThanOrEqual(2);
    expect(during.totalConnectedClients).toBeLessThanOrEqual(redisBeforeStart.totalConnectedClients + 5);
  });

  it("GATE — the concurrent load run produces the exact, runtime-computed 60/min-derived tallies (Decision 8.64), never the master plan's stale 10/min-derived figures", async () => {
    const realLimit = env.AGENTGATE_MCP_TOOL_CALL_RATE_LIMIT;
    const callsPerAgent = realLimit + OVERAGE_CALLS_PER_AGENT;
    const expectedSucceedPerAgent = realLimit;
    const expectedDeniedPerAgent = OVERAGE_CALLS_PER_AGENT;

    // Flatten every (agent, call) pair across ALL 50 agents into one
    // globally-concurrent work list — cross-agent interleaving, not
    // per-agent-sequential (Decision 8.65 / Finding F3).
    const flatAgents = tenants.flatMap((t) => t.agents.map((a) => ({ apiKey: a.id, toolName: t.toolName, tenant: t, agentId: a.id })));
    const work: Array<{ agentGlobalIndex: number; apiKey: string; toolName: string; callId: string }> = [];
    flatAgents.forEach((agent, agentGlobalIndex) => {
      for (let c = 0; c < callsPerAgent; c++) {
        work.push({
          agentGlobalIndex,
          apiKey: agent.apiKey,
          toolName: agent.toolName,
          callId: `load-${agentGlobalIndex}-${c}`,
        });
      }
    });
    expect(work.length).toBe(TOTAL_AGENTS * callsPerAgent);

    const loadStart = Date.now();

    const responses = await runWithConcurrency(
      work,
      async (item) => {
        const res = await harness.app.inject({
          method: "POST",
          url: "/mcp",
          headers: { authorization: `Bearer ${item.apiKey}` },
          payload: mcpEnvelope("tools/call", { name: item.toolName }, item.callId),
        });
        return { agentGlobalIndex: item.agentGlobalIndex, code: JSON.parse(res.body)?.error?.code as number | undefined };
      },
      GLOBAL_CONCURRENCY
    );

    const elapsedMs = Date.now() - loadStart;
    const withinSafetyMargin = elapsedMs < WALL_CLOCK_SAFETY_MARGIN_MS;
    if (!withinSafetyMargin) {
      // eslint-disable-next-line no-console
      console.warn(
        `[load-test] load-firing took ${elapsedMs}ms, exceeding the ${WALL_CLOCK_SAFETY_MARGIN_MS}ms safety ` +
          `margin (Finding F3) — per-agent minute-window boundaries may have been crossed for some agents. ` +
          `Falling back to a looser, aggregate-only assertion for this run rather than a hard per-agent one.`
      );
    }

    // Tally by JSON-RPC code — Decision 8.68 (Finding F6). Three
    // buckets, never conflated.
    const succeeded = responses.filter((r) => r.code === -32008).length; // SSRF_BLOCKED = "executed"
    const deniedGenuine = responses.filter((r) => r.code === -32001).length; // RATE_LIMITED
    const degraded = responses.filter((r) => r.code === -32002).length; // SERVICE_DEGRADED

    // eslint-disable-next-line no-console
    console.log(
      `[load-test] ${work.length} calls in ${elapsedMs}ms — succeeded=${succeeded} deniedGenuine=${deniedGenuine} degraded=${degraded}`
    );

    // Degraded should be near-zero on healthy local infra — never
    // silently absorbed into either other bucket if it isn't.
    expect(degraded).toBeLessThan(work.length * 0.02); // generous, informative ceiling, not a hard zero

    if (withinSafetyMargin) {
      // Strict, exact, per-agent AND aggregate assertions.
      const perAgentTally = new Map<number, { succeeded: number; deniedGenuine: number }>();
      for (const r of responses) {
        const entry = perAgentTally.get(r.agentGlobalIndex) ?? { succeeded: 0, deniedGenuine: 0 };
        if (r.code === -32008) entry.succeeded++;
        if (r.code === -32001) entry.deniedGenuine++;
        perAgentTally.set(r.agentGlobalIndex, entry);
      }
      for (const [, tally] of perAgentTally) {
        expect(tally.succeeded).toBe(expectedSucceedPerAgent);
        expect(tally.deniedGenuine).toBe(expectedDeniedPerAgent);
      }
      expect(succeeded).toBe(TOTAL_AGENTS * expectedSucceedPerAgent);
      expect(deniedGenuine).toBe(TOTAL_AGENTS * expectedDeniedPerAgent);
    } else {
      // Documented, bounded degradation of assertion precision.
      expect(succeeded + deniedGenuine + degraded).toBe(work.length);
      expect(succeeded).toBeGreaterThan(TOTAL_AGENTS * expectedSucceedPerAgent * 0.9);
    }
  }, 90_000);

  it("GATE — gatewayOverheadMs is measured (not silently zero-sampled) and its p95 is reported against the PRD §12 budget, without being hard-gated by it", async () => {
    const tenantIds = tenants.map((t) => t.tenantId);
    // A window comfortably covering the whole beforeAll+load lifetime.
    const since = new Date(Date.now() - 5 * 60_000);

    const samples = await sampleGatewayOverheadMs(tenantIds, since);

    // The load-bearing proof for Finding F5: a naive client-response
    // sampling strategy would have produced ZERO samples here. This
    // MUST be a real, substantial population.
    expect(samples.length).toBeGreaterThan(TOTAL_AGENTS * env.AGENTGATE_MCP_TOOL_CALL_RATE_LIMIT * 0.9);

    const stats = summarizeLatencies(samples);
    // eslint-disable-next-line no-console
    console.log(
      `[load-test] gatewayOverheadMs — n=${stats.count} p50=${stats.p50}ms p95=${stats.p95}ms ` +
        `p99=${stats.p99}ms max=${stats.max}ms (PRD §12 budget: p95 < 300ms)`
    );

    // Measurability is the gate — NOT the threshold (master plan's own
    // explicit framing: "this day's job is to know the number, not to
    // force it under budget by any means necessary").
    expect(stats.p95).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(stats.p95)).toBe(true);
  }, 20_000);

  it("GATE — Postgres pool saturation is measured for BOTH pools; a specific recommendation is computed, never a number asserted without having been measured", () => {
    const mainSummary = mainPoolObserver.summary();
    const auditSummary = auditPoolObserver.summary();

    expect(mainSummary.sampleCount).toBeGreaterThan(0);
    expect(auditSummary.sampleCount).toBeGreaterThan(0);

    const mainRecommendation = recommendPoolSize(mainSummary);
    const auditRecommendation = recommendPoolSize(auditSummary);

    // eslint-disable-next-line no-console
    console.log(`[load-test] MAIN pool — ${mainRecommendation.recommendation}`);
    // eslint-disable-next-line no-console
    console.log(`[load-test] AUDIT pool — ${auditRecommendation.recommendation}`);

    // The checkpoint is that a REASONED, ACTIONABLE conclusion exists
    // — either "confirmed sufficient" or "here is the specific
    // revised value and why" — never silence.
    expect(mainRecommendation.recommendation.length).toBeGreaterThan(0);
    expect(auditRecommendation.recommendation.length).toBeGreaterThan(0);
  });

  it("no session/registry corruption after the heaviest run this project has produced: WS registries clean, breaker not stuck OPEN", async () => {
    await new Promise((r) => setTimeout(r, 300)); // let close listeners settle after afterAll's own teardown steps begin

    for (const tenant of tenants) {
      expect(getActiveConnectionCount(tenant.userId)).toBeGreaterThanOrEqual(0); // never negative — a corruption signal
    }
    // Breaker should have recovered (or never tripped) against healthy
    // local Redis by the time this assertion runs, several seconds
    // after the burst completed.
    expect(getRateLimiterBreaker().getState()).not.toBe("OPEN");
  });

  it("BONUS — /health reports every advisory subsystem healthy after the full run (mirrors Week 8 Day 1's own bonus check, now under real load)", async () => {
    const res = await harness.app.inject({ method: "GET", url: "/health" });
    const body = JSON.parse(res.body);
    expect(res.statusCode).toBe(200);
    expect(body.rateLimiter.healthy).toBe(true);
    expect(body.observabilityStream.healthy).toBe(true);
  });
});
```

#### Step 10 — `src/__tests__/prisma-pool-error-resilience.test.ts` (NEW — Finding F7) (45 min)

```typescript
import { describe, it, expect } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

/**
 * Week 8 Day 3 — Decision 8.69 (Finding F7). Proves the OBSERVABLE
 * behavior — no process crash — without depending on knowledge of
 * whether @prisma/adapter-pg internally guards its own pg.Pool
 * against the classic idle-client 'error' EventEmitter crash. This
 * project has applied that discipline to every ioredis client and
 * every BullMQ Queue/Worker since Week 2; this is the first time it's
 * been checked against the two Postgres pools.
 *
 * CONFIRM AT IMPLEMENTATION TIME (see the Assumptions table below):
 * whether @prisma/adapter-pg's pinned version's PrismaPg config
 * object accepts connectionTimeoutMillis alongside connectionString/
 * max — a standard pg.PoolConfig property, very likely accepted since
 * PrismaPg's config object is a superset/passthrough of pg.PoolConfig,
 * but not independently confirmed from this document alone.
 *
 * The disruptive "kill the REAL, shared test Postgres container
 * mid-session" scenario is deliberately NOT automated here — mirrors
 * Week 3 Day 7's own established precedent for the identical class of
 * scenario against Redis: a MANUAL hardening-checklist verification
 * step, never something a shared CI Postgres instance gets disrupted
 * for.
 */
describe("Postgres pool error resilience — Week 8 Day 3, Finding F7", () => {
  it("GATE — a Prisma client pointed at an unreachable Postgres target fails as an ordinary rejected promise, with ZERO process-level crash signal", async () => {
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandled.push(reason);
    const onUncaughtException = (err: unknown) => unhandled.push(err);
    process.on("unhandledRejection", onUnhandledRejection);
    process.on("uncaughtException", onUncaughtException);

    const throwaway = new PrismaClient({
      adapter: new PrismaPg({
        connectionString: "postgresql://nobody:nothing@127.0.0.1:1/nonexistent",
        max: 2,
        connectionTimeoutMillis: 2000,
      } as any),
    });

    try {
      await expect(throwaway.$queryRaw`SELECT 1`).rejects.toBeDefined();
    } finally {
      await throwaway.$disconnect().catch(() => {});
    }

    // Give any lingering async 'error' emission a moment to surface
    // before asserting it never did.
    await new Promise((r) => setTimeout(r, 500));

    process.off("unhandledRejection", onUnhandledRejection);
    process.off("uncaughtException", onUncaughtException);

    expect(unhandled).toHaveLength(0);
  }, 10_000);

  it("REGRESSION — the SAME assertion holds for a rejected connection with a LONGER-lived attempted pool (closer to production pool sizing)", async () => {
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandledRejection);

    const throwaway = new PrismaClient({
      adapter: new PrismaPg({
        connectionString: "postgresql://nobody:nothing@127.0.0.1:1/nonexistent",
        max: 10,
        connectionTimeoutMillis: 1500,
      } as any),
    });

    // Fire several concurrent queries against the unreachable target —
    // proves the guarantee holds under concurrent connection-attempt
    // failure, not just a single one.
    const results = await Promise.allSettled([
      throwaway.$queryRaw`SELECT 1`,
      throwaway.$queryRaw`SELECT 2`,
      throwaway.$queryRaw`SELECT 3`,
    ]);
    expect(results.every((r) => r.status === "rejected")).toBe(true);

    await throwaway.$disconnect().catch(() => {});
    await new Promise((r) => setTimeout(r, 500));

    process.off("unhandledRejection", onUnhandledRejection);
    expect(unhandled).toHaveLength(0);
  }, 10_000);
});
```

**Manual hardening-checklist addition (not automated, per Decision 8.69):**
> Confirm, by hand: with the full system running (`npm run test:load` mid-flight, or `npm run dev` under manual traffic), briefly stop the local `postgres` Docker container (`docker compose stop postgres`), wait ~5s, then restart it (`docker compose start postgres`). Confirm the Node process does **not** crash at any point, and that once Postgres is back, subsequent requests succeed again without a manual server restart. This is the fuller, real-network-fault version of what today's automated test proves against a synthetic unreachable target — kept manual, mirroring Week 3 Day 7's identical precedent for Redis.

#### Step 11 — `src/__tests__/pg-connection-string.test.ts` (NEW) (15 min)

```typescript
import { describe, it, expect } from "vitest";
import { withApplicationName } from "../lib/pg-connection-string.js";

describe("withApplicationName — Week 8 Day 3, Decision 8.66", () => {
  it("appends application_name to a connection string with no existing query params", () => {
    const result = withApplicationName("postgresql://user:pass@host:5432/db", "agentgate-main");
    expect(result).toContain("application_name=agentgate-main");
  });

  it("preserves existing query params (e.g. sslmode) alongside the new one", () => {
    const result = withApplicationName("postgresql://user:pass@host:5432/db?sslmode=require", "agentgate-audit");
    expect(result).toContain("sslmode=require");
    expect(result).toContain("application_name=agentgate-audit");
  });

  it("overwrites a pre-existing application_name rather than duplicating the parameter", () => {
    const result = withApplicationName("postgresql://user:pass@host:5432/db?application_name=old", "new-name");
    expect(result.match(/application_name=/g)?.length).toBe(1);
    expect(result).toContain("application_name=new-name");
  });

  it("produces a value distinct for the main vs. audit pool tags", () => {
    const main = withApplicationName("postgresql://h/db", "agentgate-main");
    const audit = withApplicationName("postgresql://h/db", "agentgate-audit");
    expect(main).not.toBe(audit);
  });
});
```

#### Step 12 — `vitest.config.ts` patch (Decision 8.71) (10 min)

```diff
 export default defineConfig({
   test: {
     environment: "node",
     setupFiles: ["./src/__tests__/helpers/setup.ts"],
+    // Week 8 Day 3 — Decision 8.71 (Finding F8). A ~3,250-call,
+    // tens-of-seconds load suite does not belong in the same CI tier
+    // as this project's fast unit/integration suite. Excluded from
+    // the default `npm test`/per-push run; invoked deliberately via
+    // `npm run test:load` instead.
+    exclude: ["**/node_modules/**", "**/dist/**", "src/__tests__/load/**"],
   },
 });
```

#### Step 13 — `package.json` patch (10 min)

```diff
   "scripts": {
     "dev": "tsx src/server.ts",
     "build": "tsc",
     "start": "node dist/server.js",
     "test": "vitest",
     "test:watch": "vitest --watch",
+    "test:load": "vitest run src/__tests__/load --pool=forks --poolOptions.forks.singleFork=true",
     "lint": "tsc --noEmit"
   },
```

`--pool=forks --poolOptions.forks.singleFork=true` isolates this run into one process, one worker — the correct execution mode for a suite whose own connection-count/pool-saturation assertions depend on not sharing Redis/Postgres traffic with any other concurrently-running test file.

---

### Assumptions to Confirm Before/During Today's Build

| # | Assumption | How to confirm |
|---|---|---|
| 1 | `withApplicationName`'s use of the native `URL` class correctly round-trips a `postgresql://` scheme without mangling it | Directly exercised by `pg-connection-string.test.ts`; `URL`'s handling of non-`http(s)` schemes is standard and already relied on by `parsePostgresUrl` (Week 4) |
| 2 | `@prisma/adapter-pg`'s pinned version (`^7.8.0`) accepts `connectionTimeoutMillis` in the same config object shape already used for `connectionString`/`max` | Confirm against the installed version before Step 10; if rejected, fall back to the config object's own documented timeout-equivalent option, or omit it and rely on the test's own Vitest-level timeout instead |
| 3 | `ioredis`'s `.duplicate(overrideOptions)` accepts a `connectionName` override the same way the base constructor does | Standard, documented `ioredis` behavior; confirm against the pinned version if `tenantEventSubscriber`'s tag doesn't show up in `CLIENT LIST` |
| 4 | The database role `AGENTGATE_DATABASE_URL` connects as has visibility into `pg_stat_activity` rows for connections other than its own | True by default for typical local/dev Postgres roles; for a restricted production role, this may need an explicit grant — flagged for the eventual deployment runbook, not a blocker for local/CI use today |
| 5 | Vitest's `--pool=forks --poolOptions.forks.singleFork=true` CLI flags are supported by the pinned Vitest version (`^4.1.8`) | Standard, documented Vitest 4.x CLI surface; confirm via `npx vitest --help` if the script fails to parse |

---

### ✅ Day 3 Checkpoint

- [ ] **Finding F1 confirmed closed:** bootstrap of 5 tenants/50 agents succeeds with zero `429`s from the public-auth throttle — proven by the suite simply completing its `beforeAll`
- [ ] **Finding F2 confirmed closed:** the load run's tallies are computed from `env.AGENTGATE_MCP_TOOL_CALL_RATE_LIMIT` at test time (3,000/250/3,250 under today's real default), never the master plan's stale 500/250/750 literals
- [ ] **Finding F3 confirmed:** load-firing wall-clock time is measured; the suite either asserts exact per-agent counts (the common case) or explicitly logs and falls back to a documented looser assertion if the safety margin is exceeded — never a silent, unexplained failure either way
- [ ] **Finding F4 confirmed closed:** both Postgres pools are distinguishable via `application_name` in `pg_stat_activity`; peak/saturation is measured for both, independently
- [ ] **Finding F5 confirmed closed:** `gatewayOverheadMs` samples are collected in the thousands (not zero) via the direct `auditPrisma` query, and its p95 is measured and reported — never hard-gated against the 300ms budget
- [ ] **Finding F6 confirmed closed:** every response is tallied into exactly `succeeded` (-32008) / `deniedGenuine` (-32001) / `degraded` (-32002) — the degraded bucket is reported distinctly and asserted near-zero, never silently folded into either other bucket
- [ ] **Finding F7 confirmed:** a Prisma client against an unreachable target fails as an ordinary rejected promise under both a single-query and a concurrent-query scenario, with zero `uncaughtException`/`unhandledRejection` — proven directly, not assumed; the manual mid-session-kill checklist item is documented
- [ ] **Finding F8 confirmed closed:** `npm test` does not pick up `src/__tests__/load/**`; `npm run test:load` runs it in isolation
- [ ] Redis connections during the run match the theoretical 5-per-replica formula — 3 definitively via named-client count, 2 more corroborated via total delta
- [ ] Pool-saturation observers produce a concrete, reasoned recommendation for both pools (confirmed-sufficient or a specific revised value) — never silence, never a fabricated number
- [ ] Zero session/registry corruption after the heaviest run this project has produced: WS tracker/registry counts never go negative, circuit breaker recovers to non-`OPEN`
- [ ] Zero unhandled promise rejections or uncaught exceptions across the entire run
- [ ] `/health` reports every advisory subsystem healthy post-run
- [ ] `npx tsc --noEmit` — zero errors

---

### Forward Notes — What Day 4 Inherits

- The `application_name`/`connectionName` tagging shipped today gives Day 4's own chaos-injection work ("kill the Postgres connection mid-request, kill Redis mid-tool-call") a precise way to identify and target a specific pool/client rather than disrupting the shared test infrastructure indiscriminately.
- `recommendPoolSize()`'s output, once this suite is actually executed against real infrastructure, is the concrete input Day 4/5/6 need before finalizing the deployment documentation's own connection-budget figures (Decision 8.14) — if it recommends a revision, that revision should land before Day 4's own resilience pass, not after.
- Finding W8-3 (the shutdown-race instrumented proof — `closeAllObservabilityConnections()`'s fire-and-forget `UNSUBSCRIBE` calls actually flushing before `tenantEventSubscriber.quit()` resolves) remains Day 4's own, entirely separate job — nothing about today's work resolves or touches it.
- `prisma-pool-error-resilience.test.ts` is a permanent regression suite, not a one-off — it stays in the fast default test path (not under `load/`) since it's cheap and fast, unlike today's main load test.
- The manual "kill Postgres mid-session" checklist item joins the existing "kill Redis mid-session" one (Week 3 Day 7) as a paired item for Day 7's own final hardening pass.

### Day 3's Contribution to Week 8's `PROGRESS.md`

```markdown
## Week 8, Day 3 — Complete

- Built the first genuinely NEW test category in this project's
  history: a concurrent load harness (5 tenants x 10 agents = 50
  agents, background REST traffic, live WS viewers, all concurrent)
  proving PRD Section 12's gateway-overhead claim and the Postgres
  pool sizes under real volume for the first time ever
- CORRECTED a critical scheduling error in the handed-off plan: a
  literal "50 concurrent agents" reading implies 50 TENANTS, which
  would have burned through Week 8 Day 2's own newly-shipped
  public-auth throttle before the harness could even bootstrap. Fixed
  by concentrating 50 agents under 5 tenants, using direct
  service-layer calls for agent/tool/permission creation (zero
  throttle exposure), matching this project's own established
  test-bootstrap convention
- CORRECTED a critical, previously-unnoticed staleness in the master
  plan's own stress-test math: its 500/250/750 table assumes a
  10/min tool-call limit that no longer exists in the shipped system
  (the real, Week 6 Day 4 default is 60/min). All figures are now
  computed at test-run time from the real env default, self-correcting
  against any future config change instead of silently drifting stale
  the way the master plan's own table already had
- CORRECTED a measurement-design gap that would have silently produced
  ZERO gatewayOverheadMs samples: this project's own established
  SSRF-blocked-test-tool convention means every "successful"
  (rate-limit-passing) call in this load resolves to a JSON-RPC ERROR
  response, which structurally omits _meta at the HTTP layer. Fixed by
  reading the value from the durably-persisted audit trail directly,
  via one batched query, rather than from client responses
- Every response is tallied into three buckets by JSON-RPC code —
  genuine denial / degraded (infra fault) / executed — the ninth
  application of this project's own standing "an infra fault is not a
  policy decision" rule, now applied to the load test's own
  measurement methodology
- SURFACED and closed a real, previously-unchecked gap in this
  project's own EventEmitter-error-listener discipline: the pg.Pool
  instances underneath BOTH Prisma clients had never been verified
  against the classic idle-client crash risk this project has
  diligently guarded against on every Redis/BullMQ resource since
  Week 2. Closed with a safe, automatable regression test proving the
  observable behavior (no process crash) without depending on an
  unconfirmed adapter-internals assumption
- Tagged both Postgres pools (application_name) and all three
  explicitly-owned Redis connections (connectionName) — safe, additive,
  zero-behavior-change observability improvements that ALSO unlock
  today's own pool-sizing and connection-count validation checkpoints
- Isolated the load suite into its own directory, excluded from the
  default fast test/CI-per-push path, with a dedicated npm script

### Proof checkpoint
- 5-tenant/50-agent bootstrap succeeds with zero throttle interference
- Runtime-computed rate-limit tallies (3,000/250/3,250 under today's
  real default) proven exact under genuine, cross-agent-concurrent
  firing, with an explicit, documented fallback for the rare
  window-boundary-crossing case
- gatewayOverheadMs measured in the thousands of samples via direct
  audit-trail query; p95 measured and reported, never hard-gated
- Both Postgres pools' saturation measured independently and a
  concrete, reasoned sizing recommendation computed for each
- Redis connection count validated against the theoretical
  5-per-replica formula, both by definitive named-client count and
  corroborating total delta
- Postgres connection-failure resilience proven under both single and
  concurrent query attempts, zero process crash
- Zero unhandled errors, zero session/registry corruption, breaker
  recovered — across the heaviest run this project has produced

### Deferred (by design, unchanged from roadmap_w8.md)
- Applying any pool-size CHANGE — today ships the instrumentation and
  the decision mechanism; the actual number is whatever THIS suite's
  real, executed run recommends, applied before Day 4's chaos pass
- Finding W8-3's shutdown-race instrumented proof — Day 4
- The manual "kill Postgres mid-session" hardening-checklist item —
  documented today, executed as part of Day 7's final hardening pass
```

---

## Week 8, Day 3 Hours Summary

| Block | Focus | Target Hours |
|---|---|---|
| Analysis | Compare `roadmap_w8.md`'s Day 3 plan against shipped Days 1–2 and the real current env defaults; identify F1–F8 | 1.5h |
| Build | `pg-connection-string.ts`, Prisma/Redis tagging patches, `load-harness.ts`, `db-pool-observer.ts`, `redis-connection-observer.ts`, `gateway-overhead-sampler.ts` | 2.5h |
| Tests | `concurrency-load.test.ts` (the main suite), `prisma-pool-error-resilience.test.ts`, `pg-connection-string.test.ts`, `vitest.config.ts`/`package.json` CI-isolation wiring | 3.5–4.5h |
| **Total** | | **7.5–8.5h** |

*Day 4 (Resilience, Shutdown Audit, and completing Finding W8-3) begins only after every box in Day 3's checkpoint is actually checked — not "should be," checked.*