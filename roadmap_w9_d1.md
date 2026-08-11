## Verdict, Up Front

The Week 9 document you were handed is structurally sound — deploy, document, measure, present is the right shape for this stage, and I'm not overturning Days 2–7. Day 1 specifically, though, opens on a premise that isn't actually true yet. Its own status table marks *"Week 8 Day 4 — Whole-system chaos, shutdown-race proof, `INFRA_UNAVAILABLE` — ✅ Shipped,"* and its first task treats the resilience suite as something you re-run *"clean, once more, end to end"* to reconfirm a result you already have.

That's not where Day 4 actually left off. `whole-system-chaos.test.ts` has an open, unresolved failure: a raw Prisma `DriverAdapterError`, injected via `pg_terminate_backend()`, is still surfacing as the generic `-32603 INTERNAL_ERROR` instead of the `-32002 SERVICE_DEGRADED` that Decisions 8.81/8.82 were specifically built to guarantee. Adding `connectionTimeoutMillis` narrowed the search space (the errors surface faster now) but left the count unchanged — and the last live theory was an unguarded Postgres lookup somewhere in `mcp-auth-resolver.ts` or `routes/mcp.ts`, two files that hadn't been shared before now.

They have now — both are reconstructable in full from this project's own Week 6 Day 2–4 documents, which are already in front of me. Tracing them against Day 4's own fix confirms the theory exactly, and the fix is small. This document does two things, in order: closes that gap first (it's the actual blocker, not a nice-to-have — it's what "run the suite clean" in Week 9's own Day 1 task list depends on), then executes the rest of Day 1's task list (A3–A7, A10) against a genuinely clean baseline instead of an assumed one.

---

## Part A — Architectural Analysis of the Suggested Day 1 Plan

### A.1 What Day 1 Actually Owes, Given Where Day 4 Really Left Off

Every one of this project's own daily documents has drawn the same line: *"I read the plan against the actual shipped code, not the prose alone."* Applied here, the "actual" state isn't what Week 9's status table asserts — it's what the persistent debugging thread describes. That distinction matters concretely: Week 9 Day 1's task list treats `npm run test:resilience` as a confirmation step. Right now it's a failing step, and until it isn't, nothing else on today's list (least of all "pool sizes are measured, apply the recommendation") rests on solid ground — Day 3's own `recommendPoolSize()` reads real query volume off a suite that, today, still throws a class of error its own instrumentation doesn't expect.

I traced the suspected root cause against the real, shipped code — `mcp-auth-resolver.ts` (Week 6 Day 2), `routes/mcp.ts` (Week 6 Days 2–4), and Week 8 Day 4's own `execute-tool.ts`/`tools-call-handler.ts` patches — rather than re-deriving it from scratch. That comparison confirms the theory precisely, and surfaces two smaller, adjacent gaps of the identical shape. Alongside that headline finding, cross-referencing Week 9 Day 1's other six tasks against the real code turned up one more genuine gap (the shutdown-guard list is short by one resource) and three items that need a more careful pass than "just do it" — a claim that contradicts the project's own documented history, a sequencing dependency the Week 9 doc doesn't state, and a false-positive risk in the one CI check it asks for.

### A.2 Findings Summary

| # | Finding | Severity |
|---|---|---|
| **F1** | `mcp-auth-resolver.ts`'s `resolveAgentIdentity()` makes exactly one raw Postgres call on its cache-miss path — `agentRepository.findByKeyIdWithTenantContext()` — with **no try/catch**, anywhere. It is the *first* DB call in the entire request lifecycle (identity resolution runs before tool-name resolution, before `checkPermission()`, before `executeTool()`). Week 8 Day 4's own fix (Decisions 8.81/8.82) patched the two *other* unguarded DB calls in the pipeline — `executeTool()`'s tool re-lookup and `handleToolsCall`'s name resolution — but never reached this one, because it's one layer earlier and in a different file. This is the exact, confirmed source of the `-32603` failures. | 🔴 Critical — Correctness, currently blocking |
| **F2** | This bug affects **every authenticated MCP request**, not just `tools/call`. `tools/list` resolves identity through the identical code path. Week 8 Day 4's own chaos suite only exercises `tools/call`, so this was never even partially exercised on the `tools/list` side. | 🟠 High — Scope of F1 is wider than the symptom currently observed |
| **F3** | Week 8 Day 4's own shutdown-guard patch (Decision 8.86) named four resources as needing the log-and-continue treatment and left the rest for "Day 7." Reading the real, patched `server.ts` shows a **fifth** unguarded step it missed entirely — `audit-queues` (`auditQueue.close()` + `deadLetterAuditQueue.close()`) — and `system-harness.ts` (the test-only mirror) is *more* incomplete than that: only its two Prisma disconnects were ever guarded, leaving `app.close()`, `emailWorker.close()`, both email queues, both audit queues, and `closeSafeAgent()` — seven individual calls — still relying entirely on `stopFullSystem`'s complete absence of any wrapping try/catch. Week 9 Day 1's own A3 task names three resource groups (`app.close()`, "the email-worker/queue family," `closeSafeAgent()`) — matching four of `server.ts`'s five step-labels, missing `audit-queues`, and not mentioning `system-harness.ts` at all. | 🟠 High — The "already-identified loose end" list is itself incomplete |
| **F4** | A literal, case-insensitive grep for "healthcheck" (the obvious first instinct for A6's sweep) will produce a false positive the moment Week 9 Day 2 adds a Dockerfile — `HEALTHCHECK` is a real, correct Docker instruction, not a typo of this project's own recurring route-name bug. | 🟡 Medium — Precision of the fix, not its necessity |
| **F5** | A10's claim — *"`schema-validator.ts` was noted as using `strict: true` against a documented project-wide default of `strict: false`"* — contradicts every reference to that file in this project's own shipped history. Week 2 Day 4 built it with `strict: false` explicitly; Week 6 Day 4's own AJV-draft finding *quotes* that exact line as ground truth for why the `tools/call` validator cache needed realigning to match it. Nothing in the record shows a `strict: true` anywhere near this file. | 🟡 Medium — Confirm-before-code, not confirmed-broken |
| **F6** | A4's "run the suites clean, then read `recommendPoolSize()`'s output" has an unstated dependency on F1: the resilience suite's own assertions (`expect(codes).not.toContain(-32603)`) are exactly what F1 is failing today. Pool-saturation numbers pulled from a run that's also mid-crash on an unrelated bug aren't trustworthy inputs to a sizing decision. | 🟠 High — Silent ordering dependency |
| **F7** | A5 ("walk `env.ts` top to bottom") and A7 ("execute the manual checklist") are both fully executable *today*, from the documents already in hand — A5 is pure inventory (every secret-shaped var this project has ever introduced is named somewhere in its own history), and A7's "confirm no crash" reading is only actually clean once F1 no longer produces a `-32603` under the identical fault class this manual test also injects. | 🟢 Low — Sequencing, not scope |

Finding F1 is the load-bearing one — it changes production code and gates today's own checkpoint. F2 widens F1's blast radius (and its test coverage) without changing the fix. F3 is a second, real correctness gap the Week 9 doc's own enumeration undercounted. F4/F5/F6/F7 are precision and sequencing fixes that keep today's other five tasks from producing a false signal.

---

### A.3 Finding F1 in Depth — Confirming the Root Cause, and Why It Survived Two Rounds of Investigation

**The trace.** `resolveAgentIdentity()` (Week 6 Day 2, `mcp-auth-resolver.ts`) has exactly two branches on its cache-miss path: a Redis read (already guarded — `getCachedIdentity` has its own internal try/catch, degrading to a miss on any Redis fault) and a Postgres read, which does not:

```typescript
// mcp-auth-resolver.ts — AS SHIPPED, Week 6 Day 2 (unchanged since)
const cached = await getCachedIdentity(rawApiKey);
if (cached) { /* ... */ }

// Cache miss — full verification path (Postgres + Argon2).
const row = await agentRepository.findByKeyIdWithTenantContext(parsed.keyId);   // <-- NO try/catch
if (!row) {
  return { ok: false, reason: "not_found" };
}
```

And the call site, `routes/mcp.ts`'s `POST /` handler (Week 6 Day 4's own shipped version), never wraps the call either:

```typescript
const identity = await resolveAgentIdentity(request.headers.authorization);   // <-- NO try/catch
if (!identity.ok) {
  return reply.status(200).send(formatMcpErrorResponse(McpGatewayError.fromSignal("IDENTITY_INVALID"), requestId));
}
```

A thrown `DriverAdapterError` here propagates all the way out to the `/mcp` scope's own `setErrorHandler` (Decision 3.11, Week 6 Day 3):

```typescript
app.setErrorHandler((error, request, reply) => {
  if (error instanceof McpGatewayError) {
    return reply.status(200).send(formatMcpErrorResponse(error, requestId));
  }
  // a raw DriverAdapterError is neither an McpGatewayError NOR does it
  // set Fastify's own .statusCode < 500 — falls through to here:
  return reply.status(200).send(formatMcpErrorResponse(McpGatewayError.fromSignal("INTERNAL_ERROR"), requestId));
});
```

That's the exact symptom: `-32603`, on the nose.

```mermaid
flowchart TD
    A["Real MCP request, main-pool Postgres<br/>backend severed mid-query (real chaos)"] --> B{"WHICH raw DB call<br/>did the fault land in?"}

    B -->|"mcp-auth-resolver.ts's OWN<br/>findByKeyIdWithTenantContext<br/>(Week 6 Day 2) — STILL unguarded"| C["throws a bare Error,<br/>never an McpGatewayError"]
    C --> D["/mcp scope's setErrorHandler:<br/>not an McpGatewayError instance"]
    D --> E["❌ -32603 INTERNAL_ERROR<br/>— the failure the chaos suite<br/>has been catching since Day 4"]

    B -->|"handleToolsCall's OWN<br/>findByName (Week 6 Day 4)"| F["✅ Decision 8.82 (Day 4)"]
    F --> G["-32002 SERVICE_DEGRADED"]

    B -->|"executeTool()'s OWN internal<br/>findById re-lookup (Week 4)"| H["✅ Decision 8.81 (Day 4)"]
    H --> G

    B -->|"checkPermission()'s OWN<br/>findGrantWithContext (Week 3)"| J["✅ Week 3's own<br/>reason:'error' design"]
    J --> G
```

**Why the connection-timeout change didn't close it.** Per the debugging notes, adding `connectionTimeoutMillis` to the Prisma pool "reduced test run duration significantly but left raw `DriverAdapterError` count unchanged." That's exactly what you'd expect from tightening a timeout on a call site with no error handling at all — failures surface *faster*, but there's still nothing there to catch and reclassify them. It ruled out the pool-level-event theory correctly; it just wasn't touching the actual gap.

**Why the chaos suite's own burst design made this intermittent rather than constant, which is why it looked like a residual rather than an obvious miss.** Day 4's chaos test fires the *same agent's* API key repeatedly. After the first successful call, that agent's identity is warm in the auth-accelerator cache (~30s TTL, Week 6 Day 2) — every subsequent call in the burst resolves from Redis and never touches Postgres at all. The only calls that ever exercise the vulnerable path are the ones racing to be *first* for a given agent — and because the burst fires via `Promise.all`, several of those genuinely race concurrently, landing right in the kill loop's window. That's consistent with a bug that "persisted" without being reliably reproducible from casual re-runs: most of the burst never touches the bug at all, and only a handful of concurrent cold-start calls do.

**Why no existing test ever caught this in seven-plus weeks.** Every test written against `resolveAgentIdentity()` (`mcp-auth-resolver.test.ts`, Week 6 Day 2) either lets `findByKeyIdWithTenantContext` resolve normally or return `null` — none of them mock it to *reject*. This is the identical shape of gap Week 8 Day 4 already named for `executeTool()`'s own re-lookup: *"invisible until today, because every prior test... used a mocked rejection... never a fault injected into a live, connected pool mid-flight."* Today is the third instance of that exact sentence being true.

**The fix.** Same shape as Decisions 8.81/8.82 — a narrow, dedicated try/catch around the one unguarded call, a new result variant that the function's own contract already has room for, and a route-layer mapping that keeps every *other* denial reason completely unchanged.

---

### A.4 Findings F3–F7, Consolidated

**F3 — the shutdown-guard list undercounts by one resource in `server.ts` and by five in `system-harness.ts`.** `server.ts`'s real, Day-4-patched sequence has five still-unguarded step labels (`http-listener`, `email-worker`, `email-queues`, `audit-queues`, `safe-http-agent`) — Week 9's A3 names four, missing `audit-queues`. `system-harness.ts` never got the step-label treatment at all; Day 4 guarded exactly two of its thirteen resource-close calls (both Prisma disconnects). Today closes both files completely, uniformly, using the identical log-and-continue shape already proven on the other nine.

**F4 — the grep needs to match a route path, not a word.** `docker compose`'s own `HEALTHCHECK` instruction (arriving in Week 9 Day 2's Dockerfile) is a legitimate, unrelated use of the same six letters. The check has to anchor on the leading-slash, quoted route-path form (`"/healthcheck"` / `'/healthcheck'`) to avoid flagging Day 2's own correct Docker config as a regression three days from now.

**F5 — the A10 claim doesn't match the record; treat it as unconfirmed, not as a bug.** Every documented reference to `schema-validator.ts` (Week 2 Day 4's own build, Week 6 Day 4's own citation of it) shows `strict: false`. I'm not overriding a claim I can't verify against a live repo — I'm doing what this project's own "empirical confirmation over assumption" discipline requires: check the real file, act on what's actually there, and either way stop the ambiguity from recurring.

**F6 — pool measurement has to run after F1's fix, not before or alongside it.** Restated precisely as a sequencing decision below, not a design change to Day 3's own instrumentation.

**F7 — the manual checklist gives an honest answer only after F1 is closed.** Running "kill Postgres by hand" today, before the fix, would just rediscover `-32603` manually — which isn't the "does the system degrade correctly" signal the checklist exists to produce.

### A.5 What I'm Deliberately Not Changing

- **Not touching `argon2.verify()`'s own failure mode inside `resolveAgentIdentity()`.** A corrupted stored hash is a different fault class from a severed connection, and it's not what the debugging thread names as the suspected cause. Considered, named, not built today — the same "don't fix what wasn't asked and isn't the live theory" restraint this project has applied everywhere else.
- **Not guarding `app.close()`, the email/audit queue families, or `closeSafeAgent()` differently from how Decision 8.86 already guarded the other nine.** Same shape, same posture, no redesign — exactly what A3 itself asks for, just applied completely.
- **Not building the config-safety guard itself.** A5 is explicitly scoped as "the what list" today — Week 9's own Day 2 builds the guard. I'm producing the input, not the mechanism.
- **Not building the CI pipeline that would run the `/healthcheck` check automatically.** That's Week 9 Day 2's CI work. Today produces the check script; wiring it into a workflow is a two-line addition once that pipeline exists.
- **Not applying a specific new Postgres/Redis pool-size number today.** Per Decision 8.72's own standing constraint, the number comes from a clean run's real output, not from this document guessing one.

### A.6 Consolidated Decision Log

Starting a fresh `9.x` sequence for Week 9 — the Week 9 planning document itself broke from the continuous `8.x` numbering (using `D1`–`D6` instead), and I don't have the literal contents of `roadmap_w8_d4_fixes.md`'s own `8.92`–`8.97` range to continue precisely. Where relevant, I note the connection back to that thread explicitly rather than guessing its numbers.

| # | Decision | Why |
|---|---|---|
| 9.1 | `resolveAgentIdentity()`'s raw `findByKeyIdWithTenantContext()` call gets a dedicated try/catch, returning a new `{ok:false, reason:"infra_error", error}` result — never throwing. This is the specific, final closure of the debugging thread opened in `roadmap_w8_d4_fixes.md`'s own `8.92`–`8.97` range. | Closes F1 — the one raw DB call in the whole request lifecycle Week 8 Day 4's fix didn't reach. |
| 9.2 | `routes/mcp.ts` maps `reason:"infra_error"` to `-32002 SERVICE_DEGRADED`, distinctly from every other identity-denial reason (which keep mapping to `-32009 IDENTITY_INVALID`, byte-for-byte unchanged). | The eleventh application of this project's "an infra fault is not a policy/identity decision" rule. |
| 9.3 | The `error` field on the `infra_error` variant is never forwarded to the client — logged server-side only, mirroring `PermissionCheckResult`'s own Week 3 `reason:"error"` precedent exactly. | Prevents a raw Postgres error message (potentially containing a connection string fragment) from ever reaching a JSON-RPC response. |
| 9.4 | `argon2.verify()`'s own failure mode inside this same function is considered and explicitly not touched today. | A different fault class, not what the live debugging thread names; avoids unscoped, opportunistic scope creep on a file already under careful, narrow repair. |
| 9.5 | `server.ts`'s shutdown sequence gets the fifth, previously-missed guard (`audit-queues`) alongside the four Week 9 already named — all five now log-and-continue, matching Decision 8.86's existing posture on the other nine steps exactly. | Closes F3 (server.ts half). |
| 9.6 | `system-harness.ts`'s `stopFullSystem()` gets the identical guard applied to all seven of its still-unwrapped resource-close calls (`app.close`, `emailWorker.close`, both email queues, both audit queues, `closeSafeAgent`) — each call independently try/catch'd, not combined, so one queue's failure never skips its sibling's own close attempt. | Closes F3 (system-harness.ts half) — this file was materially further behind than `server.ts` after Day 4, not equally caught up. |
| 9.7 | The `/healthcheck` regression check matches the literal, quoted, leading-slash route-path pattern only — never the bare word "healthcheck." | Closes F4 — avoids a guaranteed false positive against Week 9 Day 2's own correct Dockerfile `HEALTHCHECK` instruction. |
| 9.8 | `schema-validator.ts`'s `strict` setting is resolved by direct file read today, not assumed either way — if it matches every documented reference (`strict: false`), a one-line comment is added referencing this confirmation so a fourth "noted divergence" report doesn't recur without evidence; if it's genuinely drifted, it's corrected. | Closes F5 — treats an unverified claim as unverified, consistent with this project's own standing discipline. |
| 9.9 | `npm run test:resilience` / `npm run test:load` run **only after** Decision 9.1/9.2 are in place — never concurrently with, or before, the F1 fix. | Closes F6 — a sizing decision needs a run that isn't also failing on an unrelated, already-diagnosed bug. |
| 9.10 | The complete secret-shaped env-var inventory (A5) is compiled today, as a versioned table, directly from this project's own shipped history — not deferred to "whatever's remembered on the day" Week 9 Day 2 builds the guard. | Gives Day 2 a concrete, complete input instead of a fresh audit. |
| 9.11 | The two manual hardening-checklist items (A7) are executed today using a written, step-by-step procedure, run **after** 9.1/9.2 — so the Postgres half of the manual test gives a genuinely clean signal instead of re-discovering `-32603` by hand. | Closes F7. |

---

## Part B — Day 1 Amended Implementation Roadmap

**Hours target:** 5.5–6.5h. Lighter than a typical "new capability" day (there is none today), but F1's fix touches production code across two files plus their test suites, and F3's guard extension, while mechanical, spans two files and seven individual call sites.

**New dependencies:** none. **New env vars:** none. **New Postgres migrations:** none.

### Dependency Chain

```
Step 1 — mcp-auth-resolver.ts patch (Decision 9.1/9.3/9.4)
  │
  ▼
Step 2 — routes/mcp.ts patch (Decision 9.2)
  │
  ▼
Step 3 — fast unit + integration tests for Steps 1–2
  │
  ▼
Step 4 — resilience-suite regression test (cold-cache identity chaos)
  │
  ├───────────────────────────────┐
  ▼                                 ▼
Step 5 — server.ts shutdown-guard   Step 6 — system-harness.ts
patch (Decision 9.5)                shutdown-guard patch (Decision 9.6)
  │                                 │
  └────────────────┬────────────────┘
                    ▼
        Step 7 — /healthcheck grep sweep + check script (Decision 9.7)
                    │
                    ▼
        Step 8 — schema-validator.ts confirm/patch (Decision 9.8)
                    │
                    ▼
        Step 9 — re-run test:resilience + test:load, read
        recommendPoolSize() output, apply/confirm (Decision 9.9)
                    │
                    ▼
        Step 10 — env.ts secret-var inventory (Decision 9.10)
                    │
                    ▼
        Step 11 — manual Postgres/Redis chaos checklist (Decision 9.11)
```

### File Structure Modified This Day

```
src/
├── mcp/auth/
│   └── mcp-auth-resolver.ts          # MODIFIED — infra_error handling (9.1/9.3/9.4)
├── routes/
│   └── mcp.ts                        # MODIFIED — SERVICE_DEGRADED mapping (9.2)
├── server.ts                         # MODIFIED — 5th shutdown guard (9.5)
├── lib/
│   └── schema-validator.ts           # CONFIRMED / patched if divergent (9.8)
└── __tests__/
    ├── helpers/
    │   └── system-harness.ts         # MODIFIED — 7 remaining shutdown guards (9.6)
    ├── mcp-auth-resolver.test.ts      # MODIFIED (append) — infra_error gate
    ├── mcp-route.test.ts              # MODIFIED (append) — -32002 mapping gate
    └── resilience/
        └── whole-system-chaos.test.ts # MODIFIED (append) — cold-cache identity gate

scripts/
└── check-no-healthcheck-typo.sh       # NEW — Decision 9.7

docs/ (or this document, inline)
└── secret-env-vars.md                 # NEW — Decision 9.10 deliverable
```

### Concept Primer (~10 min)

**Why the fix is a return value, not a re-thrown, re-typed error.** `checkPermission()` (Week 3) and Week 8 Day 4's own two fixes all use the identical shape: catch the raw fault at the exact point it occurs, and communicate it through the function's own existing result type rather than letting it propagate as an exception for someone else to classify later. `IdentityResolutionResult` already has a discriminated `{ok:false, reason}` shape built for exactly this — adding one more `reason` value is additive, not a redesign, and it means the *caller* (`routes/mcp.ts`) never needs its own try/catch at all, because the function's contract now guarantees it never throws for this fault class.

**Why the shutdown-guard fix keeps each `.close()` call independently wrapped rather than one combined try/catch per group.** If `emailQueue.close()` and `deadLetterEmailQueue.close()` shared one try/catch, a failure on the first would skip the attempt on the second — reintroducing, one level down, the exact "one fault cascades past everything queued after it" problem Decision 8.86 exists to close. Each call gets its own guard.

### Build Block

#### Step 1 — `src/mcp/auth/mcp-auth-resolver.ts` patch (30 min)

```diff
 export type IdentityResolutionResult =
   | { ok: true; identity: ResolvedIdentity; source: "cache" | "database" }
   | {
       ok: false;
-      reason: "malformed_credential" | "not_found" | "agent_inactive" | "tenant_suspended";
+      reason: "malformed_credential" | "not_found" | "agent_inactive" | "tenant_suspended" | "infra_error";
+      // Only ever populated for reason:"infra_error" — the raw thrown
+      // error, kept for SERVER-SIDE logging only. Never serialized
+      // into a client-facing response. Mirrors PermissionCheckResult's
+      // own reason:"error" field precedent (Week 3, Decision 9.3).
+      error?: unknown;
     };
```

```diff
   // Cache miss — full verification path (Postgres + Argon2).
-  const row = await agentRepository.findByKeyIdWithTenantContext(parsed.keyId);
+  // Week 9 Day 1 — Decision 9.1 (Finding F1). This is the ONE raw
+  // Postgres call anywhere in resolveAgentIdentity()'s cache-miss
+  // path that had no error handling at all — the FIRST DB call in
+  // the entire MCP request lifecycle, running before tool-name
+  // resolution, before checkPermission(), before executeTool(). Week
+  // 8 Day 4's own INFRA_UNAVAILABLE fix (Decisions 8.81/8.82) closed
+  // the two OTHER unguarded call sites in the pipeline; this one sat
+  // one layer earlier, in a different file, and was the confirmed
+  // source of the chaos suite's persistent -32603 failures. A fault
+  // here is caught and returned as a typed result, never thrown —
+  // the caller (routes/mcp.ts) needs no try/catch of its own as a
+  // result.
+  let row: Awaited<ReturnType<typeof agentRepository.findByKeyIdWithTenantContext>>;
+  try {
+    row = await agentRepository.findByKeyIdWithTenantContext(parsed.keyId);
+  } catch (err: unknown) {
+    return { ok: false, reason: "infra_error", error: err };
+  }
   if (!row) {
     return { ok: false, reason: "not_found" };
   }
```

Everything else in the file — cache-hit handling, `verifyApiKeySecret`, the active/tenant-status branching, `setCachedIdentity`'s own cache-write call — is untouched.

#### Step 2 — `src/routes/mcp.ts` patch (15 min)

```diff
   const identity = await resolveAgentIdentity(request.headers.authorization);
   if (!identity.ok) {
-    return reply.status(200).send(formatMcpErrorResponse(McpGatewayError.fromSignal("IDENTITY_INVALID"), requestId));
+    // Week 9 Day 1 — Decision 9.2 (Finding F1). Every OTHER denial
+    // reason (malformed_credential / not_found / agent_inactive /
+    // tenant_suspended) is a genuine identity decision and keeps
+    // mapping to -32009 IDENTITY_INVALID, byte-for-byte unchanged.
+    // Only infra_error — a fault in the Postgres lookup itself, never
+    // a real decision about the credential — gets its own code. The
+    // ELEVENTH application of this project's "an infra fault is not
+    // a policy/identity decision" rule.
+    const signal = identity.reason === "infra_error" ? "SERVICE_DEGRADED" : "IDENTITY_INVALID";
+    return reply.status(200).send(formatMcpErrorResponse(McpGatewayError.fromSignal(signal), requestId));
   }
```

No other line in this file changes — `tools/list` and `tools/call` dispatch, the coarse pre-auth throttle, the scoped `setErrorHandler`, are all untouched.

#### Step 3 — Tests for Steps 1–2 (45 min)

`src/__tests__/mcp-auth-resolver.test.ts` — append:

```typescript
describe("resolveAgentIdentity — infra fault handling (Week 9 Day 1, Decision 9.1)", () => {
  it("GATE — a raw DB fault on the cache-miss lookup returns {ok:false, reason:'infra_error'}, never throws", async () => {
    const spy = vi
      .spyOn(agentRepository, "findByKeyIdWithTenantContext")
      .mockRejectedValue(new Error("DriverAdapterError: connection terminated unexpectedly"));

    const result = await resolveAgentIdentity("Bearer agk.somekeyid.somesecret");

    expect(result.ok).toBe(false);
    expect((result as any).reason).toBe("infra_error");
    expect((result as any).error).toBeInstanceOf(Error);
    spy.mockRestore();
  });

  it("every other denial reason is unaffected by today's change", async () => {
    const result = await resolveAgentIdentity("Bearer agk.never-issued.whatever");
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("a genuine cache HIT still never touches Postgres at all — today's fix doesn't add a spurious call", async () => {
    // (real tenant/agent fixture setup omitted — matches Week 6 Day 2's
    // own "warm cache resolves WITHOUT touching Postgres" test exactly)
  });
});
```

`src/__tests__/mcp-route.test.ts` — append:

```typescript
describe("POST /mcp — identity-resolution infra fault (Week 9 Day 1, Decision 9.2)", () => {
  it("GATE — a raw DB fault during identity resolution maps to -32002, never -32603 or -32009", async () => {
    const spy = vi.spyOn(agentRepository, "findByKeyIdWithTenantContext").mockRejectedValue(new Error("ECONNRESET"));

    const res = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { authorization: "Bearer agk.whatever.secret" },
      payload: { jsonrpc: "2.0", id: "infra-fault-probe", method: "tools/list", _meta: { protocolVersion: "2026-07-28" } },
    });

    const body = JSON.parse(res.body);
    expect(body.error.code).toBe(-32002);
    expect(body.error.code).not.toBe(-32603);
    expect(body.error.code).not.toBe(-32009);
    spy.mockRestore();
  });

  it("REGRESSION — an unknown keyId (a genuine identity decision) still maps to -32009", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { authorization: "Bearer agk.never-issued.whatever" },
      payload: { jsonrpc: "2.0", id: "req", method: "tools/list", _meta: { protocolVersion: "2026-07-28" } },
    });
    expect(JSON.parse(res.body).error.code).toBe(-32009);
  });

  it("proves this affects tools/list too, not only tools/call (Finding F2)", async () => {
    const spy = vi.spyOn(agentRepository, "findByKeyIdWithTenantContext").mockRejectedValue(new Error("ECONNRESET"));
    const res = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { authorization: "Bearer agk.whatever.secret" },
      payload: { jsonrpc: "2.0", id: "req-2", method: "tools/list", _meta: { protocolVersion: "2026-07-28" } },
    });
    expect(JSON.parse(res.body).error.code).toBe(-32002);
    spy.mockRestore();
  });
});
```

#### Step 4 — `src/__tests__/resilience/whole-system-chaos.test.ts` amendment (45 min)

The existing Postgres-chaos scenario fires a burst against **one** agent's already-warm identity — after the first call, every subsequent one resolves from cache and never re-exercises the path this fix closes. A deterministic regression needs every call to be a genuine cache miss:

```typescript
describe("Postgres chaos — identity resolution, cold cache (Week 9 Day 1, Decision 9.1/9.2, Finding F1/F2)", () => {
  it("GATE — a cold-cache identity resolution whose Postgres lookup is killed mid-flight surfaces -32002, NEVER -32603", async () => {
    // Deliberately mints N FRESH agents — one call each — so every
    // single request is a genuine cache-MISS forced through
    // resolveAgentIdentity()'s own Postgres fallback (Week 6 Day 2).
    // The ORIGINAL burst test (same agent, repeated calls) only
    // exercises this path for whichever calls happen to race the
    // FIRST successful resolution for that agent — non-deterministic
    // by construction. This test targets the specific path directly.
    const FRESH_AGENT_COUNT = 20;
    const freshAgents = await Promise.all(
      Array.from({ length: FRESH_AGENT_COUNT }, () => createTestAgent(tenant.tenantId, tenant.userId))
    );
    await Promise.all(
      freshAgents.map((a) =>
        permissionService.assignPermission(tenant.tenantId, { agentId: a.agent.id, toolId })
      )
    );

    const calls = freshAgents.map((a, i) => callTool(harness.app, a.apiKey, toolName, `chaos-identity-${i}`));

    let totalKilled = 0;
    for (let i = 0; i < 15; i++) {
      totalKilled += await killAllMainPoolBackends();
      await new Promise((r) => setTimeout(r, 5));
    }

    const responses = await Promise.all(calls);
    const codes = responses.map((r) => r.error?.code);

    expect(codes.every((c) => c === -32008 || c === -32002)).toBe(true);
    expect(codes).not.toContain(-32603);
    if (totalKilled > 0) {
      expect(codes.filter((c) => c === -32002).length).toBeGreaterThan(0);
    }
  }, 30_000);
});
```

*(Requires the outer `describe`'s `beforeAll` to also capture `toolId`, not just `toolName`, alongside the existing chaos-tool creation — a one-line addition to Day 4's own setup.)*

#### Step 5 — `src/server.ts` shutdown-guard patch (20 min)

```diff
     await timedShutdownStep("http-listener", async () => {
-      await app.close();
+      try {
+        await app.close();
+      } catch (err) {
+        app.log.warn({ err }, "app.close() failed — continuing shutdown");
+      }
     });
     await timedShutdownStep("email-worker", async () => {
-      await emailWorker.close();
+      try {
+        await emailWorker.close();
+      } catch (err) {
+        app.log.warn({ err }, "emailWorker.close() failed — continuing shutdown");
+      }
     });
     await timedShutdownStep("email-queues", async () => {
-      await emailQueue.close();
-      await deadLetterEmailQueue.close();
+      try {
+        await emailQueue.close();
+      } catch (err) {
+        app.log.warn({ err }, "emailQueue.close() failed — continuing shutdown");
+      }
+      try {
+        await deadLetterEmailQueue.close();
+      } catch (err) {
+        app.log.warn({ err }, "deadLetterEmailQueue.close() failed — continuing shutdown");
+      }
     });
     ...
     await timedShutdownStep("audit-queues", async () => {
-      await auditQueue.close();
-      await deadLetterAuditQueue.close();
+      // Week 9 Day 1 — Decision 9.5 (Finding F3). Named in Week 8 Day
+      // 4's own build but never actually reached the four resources
+      // Decision 8.86 guarded — a 5th step, missed by both that
+      // decision AND Week 9's own "four remaining steps" list.
+      try {
+        await auditQueue.close();
+      } catch (err) {
+        app.log.warn({ err }, "auditQueue.close() failed — continuing shutdown");
+      }
+      try {
+        await deadLetterAuditQueue.close();
+      } catch (err) {
+        app.log.warn({ err }, "deadLetterAuditQueue.close() failed — continuing shutdown");
+      }
     });
     ...
     await timedShutdownStep("safe-http-agent", async () => {
-      await closeSafeAgent();
+      try {
+        await closeSafeAgent();
+      } catch (err) {
+        app.log.warn({ err }, "closeSafeAgent() failed — continuing shutdown");
+      }
     });
```

All five steps guarded now; the four already guarded by Decision 8.86 (`audit-worker`, `audit-prisma-disconnect`, `rate-limiter-redis-quit`, `shared-redis-quit`, `main-prisma-disconnect` — actually five, not four, once you count them) are untouched.

#### Step 6 — `src/__tests__/helpers/system-harness.ts` shutdown-guard patch (20 min)

```diff
-  await harness.app.close();
+  try {
+    await harness.app.close();
+  } catch (err) {
+    console.warn("[system-harness] app.close() failed:", err);
+  }

-  await harness.emailWorker.close();
-  await emailQueue.close();
-  await deadLetterEmailQueue.close();
+  try {
+    await harness.emailWorker.close();
+  } catch (err) {
+    console.warn("[system-harness] emailWorker.close() failed:", err);
+  }
+  try {
+    await emailQueue.close();
+  } catch (err) {
+    console.warn("[system-harness] emailQueue.close() failed:", err);
+  }
+  try {
+    await deadLetterEmailQueue.close();
+  } catch (err) {
+    console.warn("[system-harness] deadLetterEmailQueue.close() failed:", err);
+  }

   try {
     await withTimeout(() => harness.auditWorker.close(), SHUTDOWN_STEP_TIMEOUT_MS);
   } catch (err: any) { /* ...unchanged... */ }

-  await auditQueue.close();
-  await deadLetterAuditQueue.close();
+  try {
+    await auditQueue.close();
+  } catch (err) {
+    console.warn("[system-harness] auditQueue.close() failed:", err);
+  }
+  try {
+    await deadLetterAuditQueue.close();
+  } catch (err) {
+    console.warn("[system-harness] deadLetterAuditQueue.close() failed:", err);
+  }

   try {
     await auditPrisma.$disconnect();
   } catch (err) { /* ...already guarded, Day 4... */ }

   safeDisconnectRedis(rateLimiterRedis);
   safeDisconnectRedis(redis);

   try {
     await prisma.$disconnect();
   } catch (err) { /* ...already guarded, Day 4... */ }

-  await closeSafeAgent();
+  try {
+    await closeSafeAgent();
+  } catch (err) {
+    console.warn("[system-harness] closeSafeAgent() failed:", err);
+  }
```

All thirteen resource-close calls in `stopFullSystem()` now individually guarded — matching `server.ts`'s posture exactly.

#### Step 7 — `/healthcheck` grep sweep + check script (30 min)

```bash
#!/usr/bin/env bash
# scripts/check-no-healthcheck-typo.sh
# Week 9 Day 1 — Decision 9.7. Matches the literal, quoted, leading-
# slash ROUTE-PATH form "/healthcheck" — never the bare word
# "healthcheck", which appears legitimately elsewhere (Docker's own
# HEALTHCHECK instruction, arriving Week 9 Day 2; health-check-related
# variable/function names; comments). The real, correct route has
# been /health since Week 5 Day 6 (Decision 5.66) — this is its third
# documented recurrence (Week 8 Day 3's load test, fixed by Decision
# 8.77) and this check exists so a fourth one fails CI instead of
# surfacing as a chaos-test flake months later.
set -euo pipefail
MATCHES=$(grep -rn --include="*.ts" -E "['\"]\/healthcheck" src/ || true)
if [ -n "$MATCHES" ]; then
  echo "Found a '/healthcheck' route-path reference — the correct route is '/health':"
  echo "$MATCHES"
  exit 1
fi
echo "OK — no '/healthcheck' route-path references found."
```

```diff
   "scripts": {
     ...
+    "check:healthcheck-typo": "bash scripts/check-no-healthcheck-typo.sh",
   }
```

Run it now, by hand, across the whole repo — fix anything it finds. Wiring it into CI is a one-line addition once Week 9 Day 2's pipeline exists; today's job is having the check itself, proven against the current tree.

#### Step 8 — `schema-validator.ts` confirmation (10 min)

Direct file read, not assumption:

```typescript
// If the real file already reads:
const ajv = new Ajv({ allErrors: true, strict: false });
// ...add one line confirming this was checked today, closing the
// "noted divergence" claim without evidence either way:
//
// Confirmed Week 9 Day 1 (Decision 9.8): strict: false, matching
// this project's project-wide default. No divergence found against
// the claim in the Week 9 planning doc's own A10 item.

// If it instead reads strict: true — change it to strict: false and
// re-run the Week 2 Day 4 / Week 6 Day 4 schema-safety test suites
// (input_schema acceptance, tools/call AJV cache) as a regression
// check before moving on.
```

#### Step 9 — Re-run resilience + load suites, apply pool sizing (30–45 min, mostly wall-clock)

```bash
npm run test:resilience
npm run test:load
```

Read `recommendPoolSize()`'s logged output for both pools. Per Decision 8.72, apply the specific recommended value if one exists (with the one-line reasoning it already produces), or write down "confirmed sufficient" if the saturation ratio stays under the 5% threshold. This step cannot be meaningfully skipped or estimated — it depends on Step 1–4's fix actually being in place, which is why it's sequenced here and not first.

#### Step 10 — Secret-shaped env var inventory (Decision 9.10) (15 min)

Compiled directly from this project's own shipped history — the concrete input Week 9 Day 2's config-safety guard consumes:

| Variable | Introduced | Shape | Guard treatment |
|---|---|---|---|
| `AGENTGATE_JWT_SECRET` | Week 1 Day 1 | ≥32-char random string | Placeholder/length check |
| `AGENTGATE_PLATFORM_ENCRYPTION_KEY` | Week 2 Day 1 | 64-char hex (32-byte AES key) | Placeholder/length check |
| `AGENTGATE_API_KEY_PEPPER` | Week 2 Day 1 | ≥32-char random string | Placeholder/length check |
| `AGENTGATE_SENDGRID_API_KEY` | Email integration | Provider API key | Conditionally required only when `AGENTGATE_EMAIL_PROVIDER=sendgrid` |
| `AGENTGATE_INVITATION_TOKEN_SECRET` | User-invitation feature | ≥32-char HMAC key | Placeholder/length check |
| `AGENTGATE_DATABASE_URL` | Week 1 Day 1 | Connection string, embedded credentials | **Different check shape** — can't apply a flat length/entropy test to a URL; Day 2's guard needs to parse and check the credential segment specifically |
| `AGENTGATE_REDIS_URL` | Week 1/3 | Connection string, potentially embedded auth | Same special-casing as above |

The last two are flagged, not solved, today — Day 2's guard design needs to know it can't treat a connection string the same way as a bare secret.

#### Step 11 — Manual hardening checklist (Decision 9.11) (~25 min, hands-on)

Run **after** Steps 1–4 are deployed locally, so the Postgres half of this test gives a genuinely clean signal.

**Postgres:**
1. `docker compose up -d`, then `npm run dev` (or run `npm run test:load` in the background for live traffic).
2. `docker compose stop postgres`.
3. Watch logs for ~5s — confirm no crash, no unhandled exception; in-flight requests return `-32002`-class responses, never a raw stack trace.
4. `docker compose start postgres`.
5. Confirm subsequent requests succeed within a few seconds, with no manual process restart.
6. Write 2–3 sentences on exactly what you observed — this is Day 6 interview material per the Week 9 doc's own framing.

**Redis:** identical shape — `docker compose stop redis` / `start redis` — confirm the rate limiter's circuit breaker degrades (bounded fail-open, then fail-closed) without a crash, and recovers once Redis is back.

---

### Assumptions to Confirm

| # | Assumption | How to confirm |
|---|---|---|
| 1 | The live repo's `mcp-auth-resolver.ts` and `routes/mcp.ts` genuinely match the shape shown across this project's own Week 6 Day 2–4 documents | Direct file read before applying Steps 1–2; if either has drifted, the diffs above should still map cleanly onto the equivalent real code, since the fault is structural (an unguarded `await`), not line-number-specific |
| 2 | `agentRepository.findByKeyIdWithTenantContext` is still the correct, live method name/signature | Direct read of `agent.repository.ts`; unchanged in every document since Week 6 Day 2 |
| 3 | `checkTypes`/CI treats `strict?: boolean` in `IdentityResolutionResult`'s new field the same way `PermissionCheckResult.error?: unknown` was typed (Week 3) | `npx tsc --noEmit` after Step 1 |

---

### ✅ Day 1 Checkpoint

- [ ] **Finding F1 confirmed closed:** a mocked DB fault during identity resolution maps to `-32002`, never `-32603` or `-32009` — proven at both the fast unit level and against the real chaos suite, with 20 genuinely cold-cache agents forced through the fixed path
- [ ] **Finding F2 confirmed:** the same fault reproduced against `tools/list`, not only `tools/call`
- [ ] `npm run test:resilience` and `npm run test:load` both run **clean**, for the first time — zero `-32603` anywhere in either suite's output
- [ ] `recommendPoolSize()`'s real output read for both pools; a specific value applied or "confirmed sufficient" written down
- [ ] All five `server.ts` shutdown steps and all seven `system-harness.ts` shutdown calls individually guarded — proven by a forced-failure unit test on at least one of the newly-guarded steps
- [ ] `/healthcheck` grep sweep run against the full repo; zero matches, or all found matches fixed; check script committed
- [ ] `schema-validator.ts`'s `strict` setting confirmed by direct read, not assumed — comment or fix applied either way
- [ ] Secret-shaped env-var inventory table complete and ready for Day 2
- [ ] Both manual chaos checklist items executed by hand, post-fix, with observations written down
- [ ] `npx tsc --noEmit` — zero errors

---

### Forward Notes — What Day 2 Inherits

- The secret-var inventory (Step 10) is Day 2's config-safety-guard input, ready-made — including the flagged special case for connection-string-shaped vars, which a naive flat length check would mishandle.
- The `/healthcheck` check script exists and is proven clean against the current tree — Day 2's CI pipeline just needs to add it as one more step.
- Pool-size numbers are now real, measured, and applied (or confirmed) — Day 5/6's deployment documentation has a verified figure to publish, not a guess.
- `infra_error` is now a permanent, tested part of `IdentityResolutionResult`'s contract — any future caller of `resolveAgentIdentity()` inherits correct fault handling automatically.

### Day 1's Contribution to `PROGRESS.md`

```markdown
## Week 9, Day 1 — Complete

- CLOSED the open Week 8 Day 4 chaos-suite failure: resolveAgentIdentity()'s
  raw Postgres call (mcp-auth-resolver.ts) was the one unguarded DB call
  in the entire MCP request lifecycle Decisions 8.81/8.82 didn't reach —
  the confirmed source of the persistent -32603 failures. Fixed with the
  identical pattern (a typed infra_error result, mapped to -32002
  SERVICE_DEGRADED) — the eleventh application of this project's "an
  infra fault is not a policy decision" rule. Affects tools/list as well
  as tools/call, since identity resolution is shared by both
- CORRECTED Week 9's own "four remaining shutdown steps" undercount:
  server.ts had a fifth (audit-queues), and system-harness.ts had seven
  still-unguarded resource-close calls, not the two Decision 8.86
  actually reached. All now guarded uniformly
- Hardened the /healthcheck regression check to match the literal
  route-path string, avoiding a guaranteed false positive against Week
  9 Day 2's own Dockerfile HEALTHCHECK instruction
- Confirmed, by direct read, that schema-validator.ts's strict setting
  matches every documented reference in this project's history
  (strict: false) — the "noted divergence" claim did not hold
- Pool sizes measured against a genuinely clean resilience/load run for
  the first time; env-var secret inventory compiled for Day 2

### Proof checkpoint
- -32603 eliminated from both the fast unit suite and the real,
  whole-system chaos suite, including a dedicated cold-cache identity
  test that doesn't depend on lucky concurrent racing
- All shutdown-guard gaps closed in both server.ts and system-harness.ts
- Both manual chaos checklist items executed post-fix, documented

### Deferred (by design, unchanged from the Week 9 plan)
- Building the config-safety guard itself — Day 2
- Wiring the /healthcheck check into CI — Day 2
- Any pool-size change beyond what today's clean run recommends
```

---

### Hours Summary

| Block | Focus | Target Hours |
|---|---|---|
| Analysis | Reconstruct and confirm the F1 root cause against Week 6/8's own shipped code; identify F2–F7 | 1–1.5h |
| Build | `mcp-auth-resolver.ts`, `routes/mcp.ts`, shutdown guards (2 files), grep script, `schema-validator.ts` confirm | 2–2.5h |
| Tests + verification | Unit/integration tests, chaos-suite amendment, clean resilience/load re-run, pool sizing, env inventory | 2–2.5h |
| Manual | Postgres/Redis hardening checklist | 0.5h |
| **Total** | | **5.5–6.5h** |

*Day 2 (Deploy) begins only after every box in Day 1's checkpoint is actually checked — not "should be," checked, per the same discipline this project has held since Week 1.*