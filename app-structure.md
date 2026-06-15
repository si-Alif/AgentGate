agentgate/
│
├── src/
│   │
│   ├── app.ts                        # Fastify instance creation + ordered plugin/route registration
│   ├── server.ts                     # HTTP listen entry point + SIGTERM/SIGINT handlers
│   │
│   ├── config/
│   │   └── env.ts                    # Zod schema — validates ALL env vars, fails fast on startup
│   │
│   ├── plugins/                      # Fastify plugins wrapped with fp() — available in parent scope
│   │   ├── sensible.plugin.ts        # @fastify/sensible (reply.badRequest, reply.unauthorized, etc.)
│   │   ├── jwt.plugin.ts             # @fastify/jwt — signs and verifies user JWTs
│   │   ├── prisma.plugin.ts          # Decorates fastify instance with fastify.db (PrismaClient)
│   │   ├── redis.plugin.ts           # Decorates fastify instance with fastify.redis (ioredis)
│   │   └── tenant-context.plugin.ts  # decorateRequest('tenantContext', null) — declaration only
│   │
│   ├── hooks/                        # Reusable preHandler functions — NOT plugins
│   │   ├── authenticate.hook.ts      # Verifies JWT via request.jwtVerify()
│   │   └── attach-tenant-context.hook.ts  # Reads request.user → writes request.tenantContext
│   │
│   ├── routes/
│   │   ├── health.ts                 # GET /health — always public, real DB+Redis check in Week 8
│   │   ├── auth/
│   │   │   ├── index.ts              # Aggregates and registers all /auth routes
│   │   │   ├── register.route.ts     # POST /auth/register-tenant, POST /auth/register-user
│   │   │   ├── login.route.ts        # POST /auth/login, POST /auth/refresh, POST /auth/logout
│   │   │   └── verify.route.ts       # GET /auth/verify-email
│   │   ├── agents/                   # Week 2 — CRUD + key generation
│   │   │   └── index.ts
│   │   ├── tools/                    # Week 2 — CRUD + encryption
│   │   │   └── index.ts
│   │   ├── permissions/              # Week 3 — assign/revoke tool access
│   │   │   └── index.ts
│   │   ├── audit/                    # Week 5 — read audit events with filters
│   │   │   └── index.ts
│   │   ├── mcp/                      # Week 6 — MCP gateway (SSE + message handler)
│   │   │   ├── sse.route.ts          # GET /mcp/sse — SSE connection, agent API key auth
│   │   │   └── message.route.ts      # POST /mcp/message — JSON-RPC router
│   │   └── observability/            # Week 7 — WebSocket stream
│   │       └── stream.route.ts       # GET /observability/stream — user JWT auth
│   │
│   ├── services/                     # Business logic — no HTTP concern, no direct DB calls
│   │   ├── auth.service.ts           # Week 1
│   │   ├── agent.service.ts          # Week 2
│   │   ├── tool.service.ts           # Week 2
│   │   ├── permission.service.ts     # Week 3 — wraps checkPermission()
│   │   ├── rate-limit.service.ts     # Week 3 — wraps checkRateLimit() + Lua script
│   │   └── tool-executor.service.ts  # Week 4 — dispatcher to handlers
│   │
│   ├── repositories/                 # All DB queries live here — ALWAYS tenant-scoped
│   │   ├── tenant.repository.ts
│   │   ├── user.repository.ts
│   │   ├── agent.repository.ts       # Week 2
│   │   ├── tool.repository.ts        # Week 2
│   │   ├── permission.repository.ts  # Week 3
│   │   └── audit.repository.ts       # Week 5
│   │
│   ├── handlers/                     # Tool execution handlers — Week 4
│   │   ├── http.handler.ts
│   │   ├── postgres.handler.ts
│   │   └── web-fetch.handler.ts
│   │
│   ├── mcp/                          # MCP protocol layer — Week 6
│   │   ├── session-map.ts            # In-memory Map<sessionId, Session> — Fastify decorator
│   │   ├── session.types.ts          # Session interface definition
│   │   ├── cleanup.ts                # cleanupSession() — THE single cleanup function
│   │   └── handlers/
│   │       ├── tools-list.handler.ts
│   │       └── tools-call.handler.ts
│   │
│   ├── workers/                      # BullMQ workers — initialized in server.ts, not app.ts
│   │   ├── queues.ts                 # Named queue definitions + TypeScript job types
│   │   ├── email.worker.ts           # Week 1 (stub), real in Phase 2
│   │   └── audit.worker.ts           # Week 5
│   │
│   ├── lib/                          # Stateless utilities only — no Fastify dependency
│   │   ├── prisma.ts                 # PrismaClient singleton
│   │   ├── crypto.ts                 # AES-256-GCM encryptConfig/decryptConfig — Week 2
│   │   └── with-timeout.ts           # AbortController wrapper — Week 4
│   │
│   ├── types/
│   │   ├── fastify.d.ts              # Module augmentation: FastifyRequest.tenantContext
│   │   └── common.ts                 # Shared interfaces (TenantContext, ExecutionResult, etc.)
│   │
│   └── __tests__/
│       ├── helpers/
│       │   ├── setup.ts              # Global afterEach DB cleanup
│       │   ├── db.ts                 # cleanDatabase(), seed helpers
│       │   └── auth.ts               # registerAndLogin() helper
│       ├── health.test.ts
│       ├── auth.register.test.ts
│       ├── auth.login.test.ts
│       ├── tenant-isolation.test.ts  # Week 1 proof checkpoint
│       ├── agent.test.ts             # Week 2
│       ├── tool.test.ts              # Week 2
│       ├── rate-limit.test.ts        # Week 3 concurrency proof
│       ├── tool-executor.test.ts     # Week 4 handler isolation
│       ├── audit.test.ts             # Week 5 durability proof
│       ├── mcp.gateway.test.ts       # Week 6 integration proof
│       ├── observability.test.ts     # Week 7
│       └── tenant-isolation-concurrent.test.ts  # Week 8 stress test
│
├── prisma/
│   ├── schema.prisma
│   └── migrations/
│
├── docker-compose.yml
├── Makefile
├── tsconfig.json
├── vitest.config.ts
├── package.json
├── .env                              # Never committed
├── .env.example                      # Committed — all keys with placeholder values
└── .gitignore