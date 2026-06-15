# AgentGate — 8-Week JIT Build & Learning Roadmap

**Protocol:** Just-In-Time (JIT) — study only what the current week's code demands.
**Rule:** Each week ends with a **Proof Checkpoint**. Do not start the next week until it passes.
**Governing principle:** Build the systems that say "No" before the systems that say "Yes."

---

## Before You Start — One-Time Setup (Day 1, ~2 hours)

Do this before Week 1 begins. It has no JIT learning cost; it's mechanical scaffolding.

**Tasks:**
- Initialize Fastify + TypeScript project with `"strict": true` in `tsconfig.json`
- Set up `pino` logger (built into Fastify — zero config needed)
- Install and configure `dotenv`
- Install `Vitest` and write a single dummy test to verify the test runner works
- Set up `Prisma` and point it at a local PostgreSQL instance (Docker Compose recommended: one `postgres:16` service)

**Resources:**
- [Fastify Getting Started](https://fastify.dev/docs/latest/guides/Getting-Started/) — read sections 1 and 2 only
- [Vitest Installation](https://vitest.dev/guide/) — "Getting Started" section only (15 minutes)
- [Prisma: Set up a new project](https://www.prisma.io/docs/getting-started/setup-prisma/start-from-scratch/relational-databases-typescript-postgresql) — follow this exactly

> **Why Vitest from day one:** Tests are not a Week 8 activity. Each milestone has a proof checkpoint — a test that must pass before you proceed. If you defer testing to Week 8, you will surface compounding bugs from all 7 prior milestones at once, in the most complex deployment environment. Don't do that to yourself.

---

## Week 1 — Multi-Tenant Bedrock (Milestone 1)

### Build Task
- Define `tenants` and `users` tables in Prisma; run first migration
- Implement tenant registration + user registration (argon2 password hashing)
- Email verification: BullMQ `email` queue with a console-log stub worker (wires infrastructure without real SMTP)
- JWT issuance: access token (15 min) + refresh token (7 days)
- **TenantContext middleware** — injects `{ tenantId, userId, role }` into every request

### JIT Learning Focus

**Fastify Hooks (lifecycle) — THIS IS THE CRITICAL CONCEPT, not just Decorators.**
Fastify is not Express. You do not use `app.use()`. Instead, Fastify has a defined lifecycle with named hooks: `onRequest` fires before the route handler, `preHandler` fires after parsing. Your TenantContext middleware is a `preHandler` hook registered on a route scope. Decorators are a separate concept — they are how you *attach* the result (`request.tenantContext = {...}`) after the hook runs. You need both. Read the Hooks docs before writing a single middleware line, or you'll implement it as Express middleware, which works differently in Fastify and breaks in subtle ways.

**Prisma Relations**
You're moving from MongoDB embedding to PostgreSQL foreign keys. The key concept: a `User` belongs to a `Tenant` via a foreign key, not an embedded document. Prisma's `@relation` directive expresses this. You'll be writing `where: { tenantId: ctx.tenantId }` on every query from now on — Prisma makes this safe and type-checked.

### Resources (cap at 2 hours of reading total before coding)
- [Fastify Hooks (Lifecycle)](https://fastify.dev/docs/latest/reference/Hooks/) — Read the `onRequest` and `preHandler` sections. This is the most important doc you'll read this week.
- [Fastify Decorators](https://fastify.dev/docs/latest/reference/Decorators/) — Read after Hooks. This is how you attach `tenantContext` to the request object safely.
- [Prisma Relations](https://www.prisma.io/docs/orm/prisma-schema/data-model/relations) — Focus on one-to-many relations only. Skip the rest for now.
- [Vitest Guide](https://vitest.dev/guide/) — Getting Started section. You already installed it; now learn `describe`, `it`, `expect`.

### ✅ Week 1 Proof Checkpoint
Write an integration test (using Vitest + Supertest):
1. Create Tenant A and Tenant B, register a user in each, log both in.
2. Using Tenant A's JWT, attempt to `GET /users` scoped to Tenant B's `tenantId`.
3. Assert: response is `403` or `404`. **This test must pass before Week 2 begins.** If it passes, your isolation foundation is solid.

---

## Week 2 — Cryptography & Entity Registries (Milestone 2)

### Build Task
- `agents` table + full CRUD, all queries scoped by `tenantId`
- API key generation pipeline: `crypto.randomBytes(32).toString('base64url')` → argon2 hash → store hash → return raw key exactly once, never again
- API key rotation endpoint
- `tools` table + full CRUD
- Validate that `input_schema` submitted by tenant is itself a valid JSON Schema (using AJV)
- AES-256-GCM encryption of `handler_config` at write time

### JIT Learning Focus

**Native Node.js Crypto for AES-256-GCM**
Use Node's built-in `crypto` module — no external library. The pattern: `createCipheriv('aes-256-gcm', key, iv)`. Generate a random 12-byte IV per encryption (never reuse it). Store as a combined string: `iv:ciphertext:authTag`. This is the most important security property of your tool registry — if you get this wrong, every tenant's database credentials and API keys are exposed in plaintext if your database is breached. Spend 30 minutes understanding GCM's auth tag before writing this code.

**Argon2 for API Key Hashing**
The `argon2` npm package (not native crypto — argon2 is not in the Node stdlib). Important timing note: `argon2.verify()` takes ~100–300ms deliberately (it's a memory-hard function). This is intentional and correct. The cost is paid only once at SSE connection time, not on every tool call. Do not try to optimize it away.

**AJV for Schema Validation**
You need to validate that the JSON Schema a tenant submits *for their tool's input parameters* is itself a valid schema — before you store it. AJV exposes `ajv.validateSchema(schema)` for this. If you skip this, a tenant can submit a malformed schema that breaks every agent's `tools/list` response silently.

### Resources
- [Node.js Crypto: createCipheriv](https://nodejs.org/api/crypto.html#cryptocreatecipher) — focus on the GCM example
- [`argon2` npm package](https://www.npmjs.com/package/argon2) — README covers hash + verify in 5 minutes
- [AJV Getting Started](https://ajv.js.org/guide/getting-started.html) — `validateSchema` section specifically
- [Supertest](https://github.com/ladjs/supertest) — add this for integration tests; it wraps your Fastify app for HTTP testing without running a real server

### ✅ Week 2 Proof Checkpoint
Two tests:
1. Create a tool with a real connection string in `handler_config`. Query the raw database row directly (via Prisma `$queryRaw` or `psql`). **Assert: the stored value is ciphertext, not the plaintext.** Call `decryptConfig` in the test and assert the roundtrip produces the original string.
2. Create an agent, capture the raw API key from the response. Make a second request to retrieve the agent. **Assert: the raw key is not in the response.** Store it — you'll need it for Week 6 testing.

---

## Weeks 3 & 4 — Parallel Sprint: Guardrails + Execution Pipeline (Milestones 3 & 4)

> **This is a 2-week parallel sprint, not two sequential weeks.** M3 (permissions + rate limiting) and M4 (tool executor) have no dependency on each other — only both depend on M2. A solo developer cannot literally parallelize, but the right approach is to **interleave** them across the two weeks rather than finishing one entirely before starting the other. Suggested split: build M3.1–M3.4 in the first half of Week 3, then switch to M4.1–M4.4, then finish M3.5–M3.6 and M4.5–M4.7 in Week 4. Both must be done and proven before Week 5.

---

### Week 3 Focus — Permission Enforcement & Rate Limiting (Milestone 3)

**Build Task:**
- `agent_tool_permissions` table + CRUD: assign/revoke tool access, scoped by `tenantId`
- `checkPermission(agentId, toolId, tenantId): Promise<boolean>` — pure DB query, no side effects, independently unit-testable
- ioredis client setup with graceful shutdown handler (`redis.quit()` on SIGTERM)
- Atomic Redis Lua rate limiter: key `rate:agent:<agentId>:min:<epochMinute>`, INCR + EXPIRE in one atomic script
- `checkRateLimit(agentId, limit): Promise<{allowed: boolean, remaining: number}>` wrapper

**JIT Learning Focus:**

**ioredis — The Node.js Redis Client**
The Redis concepts you'll learn from the crash course resource are correct, but the crash course teaches Upstash (managed Redis). Your dev environment uses local Redis (Docker). The client library you'll use is `ioredis`. The important concepts this week: creating a client, using `eval()` for Lua scripts, and handling connection errors gracefully. Connection errors must not crash your server — configure `ioredis` with `retryStrategy` and `reconnectOnError`.

**Atomic Lua Scripts — Why This Matters**
Node.js is single-threaded but Redis commands from multiple async operations can interleave. If you use two separate Redis commands (`GET` then `SET`) for rate limiting, another request can land between them and both get allowed when only one should. A Lua script runs atomically — Redis executes it as a single unit with no interleaving possible. This is the correct solution and it's simple once you understand the pattern. The script is ~5 lines.

**Resources:**
- [ioredis README](https://github.com/redis/ioredis#readme) — Read the "Quick Start", "Lua Scripting", and "Error Handling" sections
- [Redis INCR pattern for rate limiting](https://redis.io/commands/incr/#pattern-rate-limiter) — This is the exact pattern your Lua script implements; read it carefully
- [Redis Lua Scripting Intro](https://redis.io/docs/manual/programmability/lua-api/) — Focus on `EVAL` command usage, not the full Lua API

---

### Week 4 Focus — Tool Execution Pipeline (Milestone 4)

**Build Task:**
- `executeTool(toolId, tenantId, agentId, inputParams)` — core dispatcher
- `withTimeout(fn, 30_000)` wrapper using `AbortController` — all handlers use this
- HTTP handler: configurable URL/method/headers, `{{param}}` body interpolation, 10MB response ceiling
- PostgreSQL query handler: `pg` library (not Prisma), parameterized queries only, fresh connection per execution, `client.end()` in `finally`
- WebFetch handler: fetch public URL, 10MB ceiling
- Structured error returns: `{status: 'success' | 'error' | 'timeout' | 'payload_too_large', result, durationMs}`

**JIT Learning Focus:**

**AbortController for Timeout Safety**
When a 30-second tool call is in-flight and the agent disconnects at second 28, the call must be cancelled — not left running to consume memory and event loop time. `AbortController` gives you a `signal` you pass to `fetch` or the `pg` client. When the timeout fires, the signal aborts the operation. Critically: wrap all handlers with `try/finally` to close database connections even when aborted. A leaked PostgreSQL connection to an external tenant database is a serious bug.

**Parameterized Queries — Non-Negotiable**
The PostgreSQL handler executes queries on *external* databases supplied by tenants. The query and its parameters come from agents at runtime. Under no circumstances should you use string interpolation (`query + params`). Use the `pg` library's parameterized query format (`$1, $2`) exclusively. SQL injection through the execution pipeline would allow an agent to run arbitrary SQL on a tenant's production database.

**Resources:**
- [MDN: AbortController](https://developer.mozilla.org/en-US/docs/Web/API/AbortController) — Read the basic example and the `fetch` integration
- [node-postgres: Parameterized Queries](https://node-postgres.com/features/queries#parameterized-query) — This is the only query format you'll use in this handler
- [`nock` for HTTP mocking in tests](https://github.com/nock/nock) — Install this now; you'll use it to mock the external HTTP target in your handler tests without needing a live server

### ✅ Weeks 3 & 4 Proof Checkpoints (both must pass before Week 5)

**M3 Checkpoint — Concurrency accuracy:**
Write a test that fires 20 *simultaneous* calls to `checkRateLimit` against one `agentId` with `limit=10`. Assert: exactly 10 return `allowed: true`, exactly 10 return `allowed: false`. The count must be exactly right — no race conditions, no over-counting. If this test fails, your Lua script has a bug. Fix it before continuing.

**M4 Checkpoint — Handler isolation under failure:**
Three tests: (1) HTTP handler with a mock that times out at 31 seconds — assert `status: 'timeout'` returned, no hanging promise. (2) PostgreSQL handler attempt — assert that the connection is closed even when the query fails mid-execution (check via connection pool monitoring). (3) WebFetch with an 11MB mock response — assert `status: 'payload_too_large'`, not a memory error.

---

## Week 5 — Async Telemetry Infrastructure (Milestone 5)

### Build Task
- `audit_events` and `tool_executions` tables (append-only: no UPDATE or DELETE routes, ever)
- Formalize BullMQ queue definitions: `audit` queue and `email` queue with proper TypeScript job types
- Audit worker: dequeue → write to PostgreSQL in a transaction → publish to Redis `events:tenant:<tenantId>` channel
- Retry strategy: 3 attempts, exponential backoff (1s → 5s → 30s)
- Dead-letter queue: failed jobs after 3 retries move to `dead-letter:audit`; log at `error` level
- `enqueueAuditEvent(event): void` — fire-and-forget, never throws, never awaited
- `GET /audit-events` read endpoint with filters (agentId, toolId, status, time range), paginated

### JIT Learning Focus

**BullMQ — Beyond the Happy Path**
The Quick Start gets a job into a queue. This week you need the parts after that: what happens when the worker crashes mid-job? (BullMQ keeps the job in "active" state and re-queues it on restart — you get this for free.) What happens when a job fails three times? (Dead-letter queue — you have to configure this explicitly.) What happens when you shut down the server with jobs in-flight? (Graceful shutdown — `worker.close()` with `force: false` drains the current job before exiting.) All three of these are in the docs; read them before building.

**`enqueueAuditEvent` must be fire-and-forget with a hard safety contract:**
This function is called on the hot path inside the gateway. It must: (1) never `await`, (2) never throw, (3) never propagate errors to the caller. Wrap the `queue.add()` call in try/catch. If BullMQ is unavailable, log a `warn` and return. An audit infrastructure failure must never cause a gateway invocation failure. This is a design principle, not an implementation detail.

### Resources
- [BullMQ Quick Start](https://docs.bullmq.io/guide/introduction) — covers the basics you already know from Summerizer's async workers
- [BullMQ: Retrying Failing Jobs](https://docs.bullmq.io/guide/retrying-failing-jobs) — read this in full; backoff configuration is here
- [BullMQ: Dead Letter Pattern](https://docs.bullmq.io/patterns/dead-letter) — this is the pattern for jobs that exhaust all retries
- [BullMQ: Graceful Shutdown](https://docs.bullmq.io/guide/workers/graceful-shutdown) — read before writing the SIGTERM handler

### ✅ Week 5 Proof Checkpoint
Two durability tests:
1. Enqueue 100 audit events in a rapid burst. Assert all 100 are present in PostgreSQL within 30 seconds.
2. Enqueue 20 events. After 10 are processed, kill the worker process (`process.exit()`). Restart it. Assert the remaining 10 jobs complete. **Both tests must pass before Week 6 begins.** The gateway will depend on this worker from its first live invocation.

---

## Week 6 — MCP Gateway Core Integration (Milestone 6)

> **This is the hardest week.** Budget 3–4 hours of reading at the start, not the usual 1–2. The SSE transport has architectural subtleties that will cause insidious bugs if you proceed on intuition alone. Read everything in the resources section before writing SSE code.

### Build Task
- `GET /mcp/sse` — SSE connection handler with dual-mode auth (API key hash verify via argon2)
- In-memory Session Map: `Map<sessionId, {agentId, tenantId, res, heartbeatTimer, idleTimer}>`
- Session creation: 128-bit crypto-random sessionId, correct SSE headers, initial `connected` event
- Heartbeat loop: `setInterval(() => res.write(': heartbeat\n\n'), 15_000)`
- Idle timeout: `setTimeout(cleanupSession, 300_000)`, reset on every valid POST
- **`cleanupSession(sessionId, reason)` — THE SINGLE cleanup function.** Every possible exit path (disconnect, timeout, graceful shutdown, write error) must call this one function. It clears the heartbeat interval, clears the idle timer, calls `res.end()` if writable, and deletes from the map. There must be no other code path that modifies the session map or closes `res`.
- Disconnect handler: `req.raw.on('close', () => cleanupSession(sessionId, 'client_disconnect'))`
- `POST /mcp/message?sessionId=<id>` — resolve session, check `res.writable` before every write, parse JSON-RPC 2.0
- `tools/list` handler: query permitted tools, format as MCP descriptors
- `tools/call` handler: full pipeline — `checkPermission` → `checkRateLimit` → `executeTool` → write response → `enqueueAuditEvent` (non-blocking) → Redis PUBLISH (non-blocking)
- Error boundary: every handler wrapped in try/catch, always writes a valid JSON-RPC error — never crashes the SSE stream
- Graceful shutdown: SIGTERM → iterate session map → call `cleanupSession` on each → drain BullMQ → close Redis → close DB

### JIT Learning Focus

**`reply.raw` — Bypassing Fastify for SSE**
Fastify's normal lifecycle sends a single response and closes. SSE requires a *never-ending* response that stays open and receives multiple `write()` calls over minutes or hours. You bypass Fastify's lifecycle using `reply.raw` to access the underlying Node.js `http.ServerResponse` object directly. Once you do this, Fastify's standard response handling is bypassed — you own the connection lifecycle entirely. Read the Fastify docs section on this before writing SSE code.

**`req.raw.on('close', ...)` — The Memory Safety Mechanism**
When a client disconnects (browser tab closes, network drop, agent process killed), Node.js fires a `close` event on the underlying socket. This is your only reliable signal to clean up the session. Without this handler, your Session Map grows forever — every disconnected agent leaves a dead `res` object in memory, a dangling heartbeat interval, and a live idle timer. Over hours, this becomes an OOM crash. Wire this handler as the very first thing after session creation.

**`res.writable` — The Crash Guard**
A tool execution takes 25 seconds. The client disconnects at second 28 (your `close` handler fires and calls `cleanupSession`, which calls `res.end()`). At second 29, the execution completes and tries to `res.write()`. If you don't check `res.writable` first, you write to a closed stream — this throws an unhandled exception that crashes the entire Fastify process. Check `res.writable` before every single `res.write()` call. This is not paranoia; it is the crash guard for the most common production failure mode.

**The Two-Channel Architecture — The Core Puzzle**
SSE is unidirectional (server → client only). JSON-RPC needs bidirectional communication. MCP solves this by using two separate HTTP channels: `GET /sse` for the server→agent push stream, and `POST /message` for the agent→server request submission. The Session Map is the only bridge between them. The `POST /message` request carries a `sessionId` that lets you look up the `res` object from the matching SSE connection. This is why the session map is the architectural linchpin — and why a single cleanup function is mandatory.

### Resources
- [Fastify `reply.raw`](https://fastify.dev/docs/latest/reference/Reply/#raw) — how to bypass Fastify lifecycle for long-lived connections
- [MDN: Server-Sent Events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events) — understand the protocol format (event framing, comment syntax for heartbeats)
- [MCP: HTTP+SSE Transport Spec](https://modelcontextprotocol.io/docs/concepts/transports#http-with-sse) — the protocol contract your gateway implements; read the session initialization and message flow sections
- [`@modelcontextprotocol/sdk` npm package](https://www.npmjs.com/package/@modelcontextprotocol/sdk) — **Install this as a dev dependency for testing.** This is how you write a real MCP client test script that connects to your gateway, calls `tools/list`, and invokes a tool. Without this, you have no way to verify the gateway works end-to-end.
- [Node.js `http.ServerResponse` writable property](https://nodejs.org/api/http.html#responsewritableended) — `writable` and `writableEnded` on the response object

### ✅ Week 6 Proof Checkpoint (Three scenarios, all must pass)
Using a test script built with `@modelcontextprotocol/sdk`:
1. **Success path:** Connect as a registered agent → call `tools/list` → verify permitted tools appear → call `tools/call` on an HTTP tool → verify result arrives over SSE → verify audit event is in PostgreSQL within 10 seconds.
2. **Permission denial:** Call a tool the agent is not assigned to → verify `-32000` JSON-RPC error → verify denial audit event in DB.
3. **Rate limit enforcement:** Call a tool 11 times against a 10/min limit → verify the 11th call returns `-32001` → verify rate-limit audit event in DB.

Additionally: connect 20 agents, disconnect all of them abruptly (kill the test process). Assert: the Session Map is empty within 30 seconds (all cleanup ran).

---

## Week 7 — Live Observability Stream (Milestone 7)

### Build Task
- `GET /observability/stream` — WebSocket endpoint with JWT auth (user token, not API key)
- Subscribe to Redis `events:tenant:<tenantId>` pub/sub channel per connection
- Forward Redis messages to the WebSocket client if `ws.readyState === WebSocket.OPEN`
- Backpressure: if `ws.bufferedAmount` exceeds threshold, close the connection gracefully (client reconnects)
- Cleanup: on WebSocket `close` event → `redis.unsubscribe()` → subscriber object becomes GC-eligible

### JIT Learning Focus

**Redis Pub/Sub — Lightweight Event Bus**
The gateway publishes to `events:tenant:<tenantId>` after every tool invocation (you built this in M5). The WebSocket handler subscribes to that channel. When Redis delivers a message, you forward it to the WebSocket. The critical operational detail: each WebSocket connection creates a Redis subscriber. If 100 dashboard clients are open, you have 100 Redis subscriber connections. Always call `unsubscribe()` and `quit()` when the WebSocket closes — or your Redis connection count grows until Redis refuses new connections.

**Fastify WebSocket Plugin**
`@fastify/websocket` wraps the `ws` library and integrates with Fastify's route system. You get access to the WebSocket object via `connection.socket` in the route handler. Your existing JWT middleware applies normally — the upgrade request goes through the full Fastify lifecycle before the WebSocket is established, so your TenantContext is already attached.

### Resources
- [`@fastify/websocket` Plugin](https://github.com/fastify/fastify-websocket) — README covers the route handler pattern in 5 minutes
- [ioredis: Pub/Sub Usage](https://github.com/redis/ioredis#pubsub) — specifically the `subscribe` and `on('message')` pattern; use a *separate* ioredis client instance for pub/sub (a subscriber connection cannot be used for other commands)

### ✅ Week 7 Proof Checkpoint
Open a WebSocket connection with a valid user JWT. In a separate process, trigger a `tools/call` via your MCP client test script from Week 6. Assert: the WebSocket receives the execution event **within 200ms** of the tool completing. Close the WebSocket and verify via ioredis diagnostics that the subscription is cleaned up (no dangling subscribers).

---

## Week 8 — Integration Testing, Hardening & Deployment (Milestone 8)

### Build Task

**Testing:**
- Eight end-to-end integration tests covering every core flow (auth, list, call, permission deny, rate limit, tenant isolation, audit completeness, WebSocket delivery)
- Tenant isolation test: Tenant A's agent cannot discover or invoke Tenant B's tools via any path — tool name guessing, direct ID access, any route
- Concurrency stress test: 50 concurrent agents, 15 calls each, 10/min limit → assert exact pass/fail counts, no session map corruption, no crashes

**Hardening:**
- SIGTERM graceful shutdown: iterate session map → close all SSE connections → drain BullMQ → close Redis → close DB (in that order)
- Health check endpoint `GET /health`: PostgreSQL `SELECT 1` + Redis `PING` → returns `{"status":"healthy"}` or `{"status":"degraded","details":{...}}`
- Environment variable validation on startup via `zod` — process exits immediately if any required variable is missing or malformed

**Deployment:**
- Multi-stage Dockerfile: TypeScript compilation in builder stage, lightweight `node:22-alpine` runtime stage, non-root user
- Docker Compose: `platform` + `postgres:16-alpine` (with volume) + `redis:7-alpine` (with volume)
- Migration on startup: `prisma migrate deploy` as entrypoint command before the server starts
- Deploy to Railway or Render; verify health check endpoint responds; document the live URL

**Documentation:**
- README with full setup instructions (local + Docker) and working `curl` examples for every core flow

### JIT Learning Focus

**Vitest Integration Tests**
You've been writing unit tests since Week 1. Integration tests are different: they spin up a real Fastify instance pointing at a real test database and Redis, run HTTP requests through the full stack, and assert on database state afterward. Vitest supports this via `beforeAll` (start the server) and `afterAll` (stop it, drop test data). Use a separate test database to avoid contaminating development data.

**Multi-Stage Docker for Node.js**
Stage 1 (builder): `node:22-alpine`, copy source, `npm ci`, run `tsc` → produces `dist/`. Stage 2 (runtime): fresh `node:22-alpine`, copy only `dist/` and `node_modules`, set `USER node`, expose port, set entrypoint. The point of two stages: your final image contains no TypeScript source, no build tools, no dev dependencies. It's lean and has a minimal attack surface.

### Resources
- [Vitest: Testing with a real database](https://vitest.dev/guide/) — "Global Setup" section for `beforeAll`/`afterAll` patterns
- [Supertest with Fastify](https://github.com/ladjs/supertest) — `inject()` vs Supertest: Fastify has its own `app.inject()` for testing without a live server — it's faster and preferred
- [Docker: Node.js Multi-Stage Builds](https://docs.docker.com/language/nodejs/containerize/) — the official Node.js guide
- [Railway Deployment](https://docs.railway.app/guides/deploy) — straightforward once your Docker image is working

### ✅ Week 8 Proof Checkpoint (the MVP success criteria)
These are the gates from the original blueprint — all must pass:
1. An MCP-compatible agent connects to the deployed public URL, calls `tools/list`, and invokes a real tool end-to-end
2. Tool invocation gateway overhead (excluding the external system's response time) is p95 under 300ms
3. Tenant A's API key cannot see or call anything belonging to Tenant B — proven by test, not assumption
4. Audit log captures every invocation with correct attribution: agent ID, tool ID, tenant ID, status, duration

---

## Quick Reference: Dependency Chain

```
Week 1 (M1: Auth + Tenancy)
  │
  │  TenantContext middleware must exist before any
  │  data is written or read. Isolation test must pass.
  │
  ▼
Week 2 (M2: Registries + Encryption)
  │
  │  Agents + tools must exist before permissions or
  │  execution can reference them. Encryption roundtrip
  │  test must pass before the executor can decrypt configs.
  │
  ├─────────────────────────────────────┐
  │                                     │
  ▼                                     ▼
Week 3 (M3: Permissions + Rate Limit)  Week 4 (M4: Tool Executor)
  │                                     │
  │   Independent modules. Interleave   │
  │   across weeks 3 and 4. Both        │
  │   proof checkpoints must pass       │
  │   before Week 5 begins.             │
  │                                     │
  └─────────────────┬───────────────────┘
                    │
                    ▼
              Week 5 (M5: Audit Infrastructure)
                    │
                    │  BullMQ durability tests must
                    │  pass. Gateway depends on this
                    │  from first invocation.
                    │
                    ▼
              Week 6 (M6: MCP Gateway — Integration Nexus)
                    │
                    │  All three gateway proof scenarios
                    │  must pass with a real MCP client.
                    │  This is the hardest week.
                    │
                    ▼
              Week 7 (M7: WebSocket Observability)
                    │
                    │  Events exist in pub/sub only
                    │  after gateway is live.
                    │
                    ▼
              Week 8 (M8: Hardening + Deployment)
```

---

## Daily Practice Rules (from the original plan, preserved — these are correct)

**Avoid Tutorial Hell.** Cap reading at 1–2 hours at the start of each week (3–4 for Week 6 only). Get a "Hello World" working for the week's core technology before building the AgentGate-specific feature. The moment you have something running, stop reading and start building.

**Leverage your existing experience.** BullMQ queues and workers are conceptually identical to the async worker pools you built for Summerizer — different API, same mental model. PostgreSQL foreign keys and parameterized queries are things you know from Project Camp. You are not starting from zero; you are translating existing knowledge into a new runtime.

**Test-as-you-build, not test-at-the-end.** Each week's proof checkpoint is a hard gate. If it fails, you do not proceed. Discovering in Week 6 that your Week 2 encryption is wrong is recoverable. Discovering it in Week 8 when everything depends on it is a crisis.

**The Single Cleanup Function is sacred.** In Week 6, the `cleanupSession()` function is the most important function in the codebase from a reliability standpoint. Every session exit path must go through it. Write it first. Test it independently. Never duplicate its logic elsewhere.