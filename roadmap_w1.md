# AgentGate — Week 1 Daily Roadmap
## Multi-Tenant Bedrock: Auth, Tenant Isolation & JWT

**Target:** By end of Day 7, you have a running Fastify server where every request to a protected route carries a verified `TenantContext`, passwords are hashed, JWTs are issued, and the proof checkpoint test — Tenant A cannot touch Tenant B's data — passes.

**Hours to commit:** 5–6 focused hours per day (net productive time, not clock time).
If you only have 3–4h/day, extend Week 1 to 10 days — do not compress and skip tests.

---

## Hours Framework (Read This First)

| Session | Duration | What You're Doing |
|---|---|---|
| **JIT Learning Block** | Capped per day (see each day) | Read only the specified sections. Close the tab when the cap hits. |
| **Build Block** | Rest of the day | Write code. Refer to docs only when stuck — not before. |
| **End-of-Day Test Run** | Last 15 min every day | `npx vitest`. If failing: add a `TODO` comment, commit, fix first thing tomorrow. |

**Clock time vs. net time:** 5 focused hours = ~7 clock hours with coffee breaks, short interruptions, and compilation waits. Plan accordingly.

---

## Pre-Week Setup (Before Day 1 — 1–2h one-time)

Do this before anything else. It has no learning cost, just mechanical installation.

### Install
- **Node.js 22 LTS** — nodejs.org/en/download (pick the LTS installer for your OS)
- **Docker Desktop** — docker.com/products/docker-desktop
- **TablePlus** (free tier) or **DBeaver** (free) — a GUI to inspect your PostgreSQL database visually. You will use this every day.
- **VS Code** with the **Prisma** extension installed (search "Prisma" in VS Code extensions)

### Verify
```bash
node --version     # should print v22.x.x
docker --version   # should print Docker version ...
```

Start your Docker Compose stack (you'll create the file on Day 2, so skip this for now and come back after Day 2 Step 1).

---

## Day 1 — Project Foundation + Fastify Mental Model

**Hours target:** 5–6h
**JIT Learning cap:** 1.5h
**End-of-day state:** A running Fastify server on `localhost:3000` with TypeScript strict mode, environment validation, structured logging, and one passing Vitest test.

---

### JIT Learning Block — 1.5h (do this first, in order, then stop)

**Resource 1 — Fastify Getting Started (30 min)**
URL: https://fastify.dev/docs/latest/guides/Getting-Started/
Read: "Your first server" and "Your first plugin" only.
Stop reading when you reach "Validate your data."
**What to absorb:** Fastify is not Express. There is no `app.use()`. Features are added via `fastify.register()`. Everything lives in plugins. Keep this mental model — you'll use it all week.

**Resource 2 — Fastify Hooks (30 min)**
URL: https://fastify.dev/docs/latest/reference/Hooks/
Read: The lifecycle diagram at the top of the page. Then the `onRequest` and `preHandler` sections.
Stop after `preHandler`.
**What to absorb:** This is how middleware works in Fastify — not via `app.use()`, but via named lifecycle hooks. Your TenantContext middleware (Day 5) is a `preHandler` hook. You are not implementing it today. You are just learning the concept exists so it doesn't surprise you.
**Do not skip this resource.** The most common mistake with Fastify coming from Express is implementing auth middleware the Express way. It will appear to work and then fail in subtle ways under load.

**Resource 3 — Vitest Getting Started (30 min)**
URL: https://vitest.dev/guide/
Read: "Getting Started" section only. Install it, run the example test, see it pass.
**What to absorb:** `describe`, `it`, `expect`. That's all you need today.

---

### Build Block — 4h

Work through these steps in order. Do not skip ahead.

**Step 1 — Initialize the project (30 min)**

```bash
mkdir agentgate && cd agentgate
git init
npm init -y
npm install fastify
npm install -D typescript @types/node ts-node vitest pino-pretty
npx tsc --init
```

Edit `tsconfig.json`. Change these three values:
```json
{
  "compilerOptions": {
    "strict": true,
    "outDir": "./dist",
    "rootDir": "./src"
  }
}
```

Add to `package.json` scripts:
```json
{
  "scripts": {
    "dev": "ts-node src/server.ts",
    "test": "vitest"
  }
}
```

**Step 2 — Project folder structure (15 min)**

Create this folder layout. All folders are empty for now — you are establishing the architecture, not filling it in yet:

```
src/
  app.ts            ← Fastify instance creation + plugin registration
  server.ts         ← Entry point: starts the HTTP server
  plugins/          ← Auth hooks, tenant context, etc. (filled in Day 5)
  routes/
    auth/           ← Login, register, verify email (Days 3 & 4)
  services/         ← Business logic (auth.service.ts in Day 3)
  repositories/     ← Database query functions (always tenant-scoped)
  workers/          ← BullMQ workers (Day 3)
  lib/              ← Utilities: crypto, prisma singleton, env
  __tests__/        ← All test files live here
```

**Step 3 — Environment validation with zod (30 min)**

```bash
npm install zod dotenv
```

Create `.env`:
```
DATABASE_URL=postgresql://postgres:password@localhost:5432/agentgate
REDIS_URL=redis://localhost:6379
JWT_SECRET=change-this-to-a-random-string-at-least-32-chars-long
PLATFORM_ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
PORT=3000
NODE_ENV=development
```

Create `.env.example` (same content but with placeholder values — this goes in git).
Add `.env` to `.gitignore` immediately.

Create `src/lib/env.ts`:
```typescript
import { z } from 'zod'
import 'dotenv/config'

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  JWT_SECRET: z.string().min(32),
  PLATFORM_ENCRYPTION_KEY: z.string().length(64),
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
})

export const env = envSchema.parse(process.env)
```

This file throws immediately if any variable is missing or malformed. The server never starts in a misconfigured state.

**Step 4 — Fastify app setup (30 min)**

Create `src/app.ts`:
```typescript
import Fastify, { FastifyInstance } from 'fastify'
import { env } from './lib/env'

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: 'info',
      transport: env.NODE_ENV === 'development'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
    },
  })

  // Health check — always public, no auth
  app.get('/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
  }))

  return app
}
```

Create `src/server.ts`:
```typescript
import { buildApp } from './app'
import { env } from './lib/env'

async function main() {
  const app = await buildApp()

  try {
    await app.listen({ port: env.PORT, host: '0.0.0.0' })
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}

main()
```

Run it: `npm run dev`
Test it: `curl http://localhost:3000/health` → should return `{"status":"ok","timestamp":"..."}`

**Step 5 — First Vitest test (45 min)**

Create `src/__tests__/health.test.ts`:
```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { buildApp } from '../app'

describe('Health Check', () => {
  const app = buildApp()

  afterAll(async () => {
    const resolved = await app
    await resolved.close()
  })

  it('returns 200 with ok status', async () => {
    const resolved = await app
    const response = await resolved.inject({
      method: 'GET',
      url: '/health',
    })

    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.body).status).toBe('ok')
  })

  it('returns 404 for unknown routes', async () => {
    const resolved = await app
    const response = await resolved.inject({
      method: 'GET',
      url: '/this-does-not-exist',
    })
    expect(response.statusCode).toBe(404)
  })
})
```

Note on `app.inject()`: this is Fastify's built-in test tool. It simulates HTTP requests without opening a TCP socket. This is faster and more reliable than Supertest for Fastify. Use it for all tests this week.

Run: `npm test`
Both tests must pass before you stop for the day.

**Step 6 — Git commit (5 min)**

```bash
git add .
git commit -m "feat: project scaffold — Fastify, TypeScript strict, Vitest, env validation"
```

---

### ✅ Day 1 End-of-Day Checkpoint

Before you close your laptop:
- [ ] `npm run dev` starts without errors; `curl localhost:3000/health` returns `{"status":"ok",...}`
- [ ] Missing a required env var (try deleting `JWT_SECRET` from `.env`) causes an immediate crash with a clear error message
- [ ] `npm test` passes 2 tests
- [ ] Folder structure is in place (empty folders are fine)
- [ ] `.env` is in `.gitignore`

---

## Day 2 — PostgreSQL + Prisma Schema

**Hours target:** 5–6h
**JIT Learning cap:** 1h
**End-of-day state:** PostgreSQL running in Docker, Prisma connected, `tenants` and `users` tables migrated. You can open TablePlus, see both tables, and the Vitest database connection test passes.

---

### JIT Learning Block — 1h

**Resource 1 — Prisma Setup from Scratch (30 min)**
URL: https://www.prisma.io/docs/getting-started/setup-prisma/start-from-scratch/relational-databases-typescript-postgresql
Read: Follow the guide exactly up to and including "Create a migration." Stop before "Querying the database."
**What to absorb:** The `schema.prisma` file structure, how `@id @default(uuid())` works, how to run `prisma migrate dev`.

**Resource 2 — Prisma One-to-Many Relations (20 min)**
URL: https://www.prisma.io/docs/orm/prisma-schema/data-model/relations/one-to-many-relations
Read: The first two examples only.
**What to absorb:** How `Tenant` has `users User[]` and `User` has `tenant Tenant @relation(...)`. This is how MongoDB embedding maps to PostgreSQL foreign keys. You'll use this exact pattern today.

**Resource 3 — Prisma Client Singleton pattern (10 min)**
URL: https://www.prisma.io/docs/orm/prisma-client/setup-and-configuration/databases-connections#prevent-hot-reloading-from-creating-new-instances
Read: The singleton pattern code block only.
**What to absorb:** How to create one PrismaClient instance and reuse it. Copy this pattern exactly.

---

### Build Block — 4–5h

**Step 1 — Docker Compose (30 min)**

Create `docker-compose.yml` in the project root:
```yaml
version: '3.8'
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: agentgate
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: password
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data

volumes:
  postgres_data:
  redis_data:
```

```bash
docker compose up -d
docker compose ps    # both services should show "running"
```

**Step 2 — Install and initialize Prisma (20 min)**

```bash
npm install prisma @prisma/client
npx prisma init --datasource-provider postgresql
```

This creates `prisma/schema.prisma`. Confirm the `DATABASE_URL` in your `.env` matches your Docker Compose config: `postgresql://postgres:password@localhost:5432/agentgate`

**Step 3 — Define the schema (1h)**

Replace the contents of `prisma/schema.prisma`:
```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Tenant {
  id        String   @id @default(uuid())
  name      String
  slug      String   @unique
  plan      String   @default("free")
  settings  Json     @default("{}")
  createdAt DateTime @default(now()) @map("created_at")

  users User[]

  @@map("tenants")
}

model User {
  id                 String    @id @default(uuid())
  tenantId           String    @map("tenant_id")
  email              String    @unique
  passwordHash       String    @map("password_hash")
  role               String    @default("member")
  isVerified         Boolean   @default(false) @map("is_verified")
  verificationToken  String?   @map("verification_token")
  refreshTokenHash   String?   @map("refresh_token_hash")
  createdAt          DateTime  @default(now()) @map("created_at")

  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@map("users")
}
```

**Step 4 — Run the migration (15 min)**

```bash
npx prisma migrate dev --name init
npx prisma generate
```

Open TablePlus. Connect to `localhost:5432`, database `agentgate`, user `postgres`, password `password`.
You should see two tables: `tenants` and `users`. Verify the columns match the schema.

**Step 5 — Create the Prisma singleton (20 min)**

Create `src/lib/prisma.ts`:
```typescript
import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ['error', 'warn'],
  })

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma
}
```

**Step 6 — Database connection test (30 min)**

Create `src/__tests__/database.test.ts`:
```typescript
import { describe, it, expect, afterAll } from 'vitest'
import { prisma } from '../lib/prisma'

describe('Database Connection', () => {
  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('connects to PostgreSQL and can execute a query', async () => {
    const result = await prisma.$queryRaw<Array<{ result: number }>>`SELECT 1 as result`
    expect(result[0].result).toBe(1)
  })

  it('can create and read a tenant', async () => {
    const tenant = await prisma.tenant.create({
      data: {
        name: 'Test Tenant',
        slug: 'test-tenant-' + Date.now(),
      },
    })
    expect(tenant.id).toBeDefined()
    expect(tenant.plan).toBe('free')

    // Cleanup
    await prisma.tenant.delete({ where: { id: tenant.id } })
  })
})
```

Run `npm test`. All 4 tests (2 from Day 1 + 2 new) should pass.

**Step 7 — Repository layer foundation (30 min)**

Create `src/repositories/tenant.repository.ts`:
```typescript
import { prisma } from '../lib/prisma'

export const tenantRepository = {
  findById: (id: string) =>
    prisma.tenant.findUnique({ where: { id } }),

  findBySlug: (slug: string) =>
    prisma.tenant.findUnique({ where: { slug } }),

  create: (data: { name: string; slug: string }) =>
    prisma.tenant.create({ data }),
}
```

Create `src/repositories/user.repository.ts`:
```typescript
import { prisma } from '../lib/prisma'

export const userRepository = {
  // NOTE: every query that returns users MUST scope by tenantId
  findByEmail: (email: string) =>
    prisma.user.findUnique({ where: { email } }),

  findById: (id: string, tenantId: string) =>
    prisma.user.findFirst({ where: { id, tenantId } }),

  findByVerificationToken: (token: string) =>
    prisma.user.findFirst({ where: { verificationToken: token } }),

  create: (data: {
    tenantId: string
    email: string
    passwordHash: string
    role: string
    verificationToken: string
  }) => prisma.user.create({ data }),

  updateVerified: (id: string) =>
    prisma.user.update({
      where: { id },
      data: { isVerified: true, verificationToken: null },
    }),

  updateRefreshTokenHash: (id: string, hash: string | null) =>
    prisma.user.update({
      where: { id },
      data: { refreshTokenHash: hash },
    }),
}
```

**Step 8 — Git commit**
```bash
git add .
git commit -m "feat: Prisma schema — tenants + users tables, first migration, repository layer"
```

---

### ✅ Day 2 End-of-Day Checkpoint

- [ ] `docker compose ps` shows both `postgres` and `redis` running
- [ ] `npx prisma studio` (run it, open the browser tab) shows `tenants` and `users` tables
- [ ] `npm test` passes 4 tests
- [ ] `src/repositories/` has `tenant.repository.ts` and `user.repository.ts`

---

## Day 3 — Registration + Password Hashing + Email Queue Stub

**Hours target:** 5–6h
**JIT Learning cap:** 45 min
**End-of-day state:** `POST /auth/register-tenant` and `POST /auth/register-user` work. Passwords are argon2-hashed. A BullMQ email queue is initialized with a console-log stub worker. Email verification tokens are stored and the verify-email endpoint works.

---

### JIT Learning Block — 45 min

**Resource 1 — `argon2` npm package (15 min)**
URL: https://www.npmjs.com/package/argon2
Read: The README. Focus on `hash(password)` and `verify(hash, password)`.
**What to absorb:** `argon2.hash()` deliberately takes 100–300ms. This is the point — it's a memory-hard function that makes brute-force attacks expensive. Do not try to optimize it away. It runs once on registration and once on login.

**Resource 2 — Fastify Request Validation (20 min)**
URL: https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/
Read: "Validation" and "Serialization" sections.
**What to absorb:** Fastify validates request bodies using JSON Schema defined inline on the route. Serialization schemas control what goes into the response — this is how you guarantee `passwordHash` never leaks into a response body.

**Resource 3 — BullMQ Quick Start (10 min)**
URL: https://docs.bullmq.io/guide/introduction
Read: The "Quick Start" example only.
**What to absorb:** `Queue` adds jobs. `Worker` processes jobs. That's the entire mental model for today.

---

### Build Block — 4.5h

**Step 1 — Install dependencies (10 min)**

```bash
npm install argon2 bullmq ioredis @fastify/sensible fastify-plugin
```

`@fastify/sensible` adds `reply.badRequest()`, `reply.unauthorized()`, `reply.conflict()`, etc. — cleaner than manually setting `reply.status(400).send(...)`.

**Step 2 — Register `@fastify/sensible` in `app.ts` (10 min)**

```typescript
import sensible from '@fastify/sensible'
// Inside buildApp():
await app.register(sensible)
```

**Step 3 — BullMQ email worker stub (30 min)**

Create `src/workers/email.worker.ts`:
```typescript
import { Worker, Queue } from 'bullmq'
import IORedis from 'ioredis'
import { env } from '../lib/env'

export const redisConnection = new IORedis(env.REDIS_URL, {
  maxRetriesPerRequest: null,  // required by BullMQ
})

export const emailQueue = new Queue('email', { connection: redisConnection })

export const emailWorker = new Worker(
  'email',
  async (job) => {
    // STUB: Replace with real email sending in production
    console.log(`\n[EMAIL STUB] ─────────────────────────────`)
    console.log(`  Type:  ${job.data.type}`)
    console.log(`  To:    ${job.data.email}`)
    if (job.data.type === 'verification') {
      console.log(`  URL:   /auth/verify-email?token=${job.data.token}`)
    }
    console.log(`──────────────────────────────────────────\n`)
  },
  { connection: redisConnection }
)

emailWorker.on('failed', (job, err) => {
  console.error(`[EMAIL WORKER] Job ${job?.id} failed:`, err.message)
})
```

**Step 4 — Auth service (1h)**

Create `src/services/auth.service.ts`:
```typescript
import argon2 from 'argon2'
import crypto from 'crypto'
import { tenantRepository } from '../repositories/tenant.repository'
import { userRepository } from '../repositories/user.repository'
import { emailQueue } from '../workers/email.worker'
import { prisma } from '../lib/prisma'

export const authService = {
  async registerTenant(data: {
    tenantName: string
    slug: string
    ownerEmail: string
    password: string
  }) {
    // Check slug uniqueness
    const existing = await tenantRepository.findBySlug(data.slug)
    if (existing) throw new Error('SLUG_TAKEN')

    const passwordHash = await argon2.hash(data.password)
    const verificationToken = crypto.randomBytes(32).toString('hex')

    // Create tenant + owner user in one transaction
    const result = await prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({
        data: { name: data.tenantName, slug: data.slug },
      })
      const user = await tx.user.create({
        data: {
          tenantId: tenant.id,
          email: data.ownerEmail,
          passwordHash,
          role: 'owner',
          verificationToken,
        },
      })
      return { tenant, user }
    })

    // Enqueue verification email (non-blocking — fire and forget)
    emailQueue
      .add('verification', {
        type: 'verification',
        email: data.ownerEmail,
        token: verificationToken,
      })
      .catch((err) => console.error('[EMAIL QUEUE] Failed to enqueue:', err))

    return {
      tenant: result.tenant,
      user: { id: result.user.id, email: result.user.email, role: result.user.role },
    }
  },

  async verifyEmail(token: string) {
    const user = await userRepository.findByVerificationToken(token)
    if (!user) throw new Error('INVALID_TOKEN')
    await userRepository.updateVerified(user.id)
    return { verified: true }
  },
}
```

**Step 5 — Auth routes: register + verify (1.5h)**

Create `src/routes/auth/register.ts`:
```typescript
import { FastifyInstance } from 'fastify'
import { authService } from '../../services/auth.service'

export async function registerRoutes(app: FastifyInstance) {
  // POST /auth/register-tenant
  app.post(
    '/register-tenant',
    {
      schema: {
        body: {
          type: 'object',
          required: ['tenantName', 'slug', 'ownerEmail', 'password'],
          properties: {
            tenantName: { type: 'string', minLength: 2 },
            slug: { type: 'string', minLength: 2, pattern: '^[a-z0-9-]+$' },
            ownerEmail: { type: 'string', format: 'email' },
            password: { type: 'string', minLength: 8 },
          },
        },
        response: {
          201: {
            type: 'object',
            properties: {
              tenant: { type: 'object' },
              user: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  email: { type: 'string' },
                  role: { type: 'string' },
                  // passwordHash is NOT in this schema — it will never appear in response
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const result = await authService.registerTenant(request.body as any)
        return reply.status(201).send(result)
      } catch (err: any) {
        if (err.message === 'SLUG_TAKEN') {
          return reply.conflict('A tenant with this slug already exists')
        }
        throw err
      }
    }
  )

  // GET /auth/verify-email
  app.get(
    '/verify-email',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['token'],
          properties: { token: { type: 'string' } },
        },
      },
    },
    async (request, reply) => {
      try {
        const { token } = request.query as { token: string }
        await authService.verifyEmail(token)
        return reply.send({ message: 'Email verified successfully' })
      } catch (err: any) {
        if (err.message === 'INVALID_TOKEN') {
          return reply.badRequest('Invalid or expired verification token')
        }
        throw err
      }
    }
  )
}
```

Register in `app.ts`:
```typescript
app.register(registerRoutes, { prefix: '/auth' })
```
(You'll need to import `registerRoutes` from the routes file.)

**Step 6 — Tests (45 min)**

Create `src/__tests__/auth.register.test.ts`:
```typescript
describe('Tenant Registration', () => {
  it('should create a tenant and owner user, returning 201')
  it('should NOT include passwordHash in the response body')
  it('should store an argon2 hash (not plaintext) in the database')
  it('should return 409 Conflict if the tenant slug is already taken')
  it('should return 400 if required fields are missing')
  it('should return 400 if email format is invalid')
  it('should return 400 if password is shorter than 8 characters')
})

describe('Email Verification', () => {
  it('should mark the user as verified with a valid token')
  it('should return 400 for an invalid or expired token')
})
```
Implement each test using `app.inject()`. For the hash test, after registering, query the DB via `prisma.user.findFirst({where: {email}})` and assert the `passwordHash` field starts with `$argon2` and is not equal to the plaintext password.

**Step 7 — Git commit**
```bash
git commit -m "feat: tenant registration, argon2 hashing, email verification stub via BullMQ"
```

---

### ✅ Day 3 End-of-Day Checkpoint

- [ ] `POST /auth/register-tenant` returns `201` with tenant + user (no `passwordHash` in response)
- [ ] Console shows `[EMAIL STUB]` output with the verification URL when you register
- [ ] `GET /auth/verify-email?token=<t>` marks the user as verified
- [ ] Querying the database: `passwordHash` column contains an argon2 hash string starting with `$argon2`
- [ ] `npm test` passes (aim for 12+ tests total across all files)

---

## Day 4 — JWT Authentication: Login, Refresh, Logout

**Hours target:** 5h
**JIT Learning cap:** 45 min
**End-of-day state:** Full login flow works. A user can log in, receive an access + refresh token, use the refresh token to get a new access token, and log out. Protected routes return `401` for unauthenticated requests.

---

### JIT Learning Block — 45 min

**Resource 1 — `@fastify/jwt` plugin (25 min)**
URL: https://github.com/fastify/fastify-jwt
Read: The README sections: "Install," "Usage," and "Auth Protect." Skip "Payload."
**What to absorb:** You register the plugin with a `secret`. Then `app.jwt.sign(payload)` issues a token. On the request side, `await request.jwtVerify()` verifies the token and attaches the decoded payload to `request.user`. This is the Fastify-native pattern — cleaner than calling `jsonwebtoken` directly.

**Resource 2 — Fastify Decorators for auth (20 min)**
URL: https://fastify.dev/docs/latest/guides/Securing-Your-App/
Read: The "Authentication" section and the "Protecting routes using preHandler" example.
**What to absorb:** How to write an `authenticate` function and attach it as a `preHandler` on individual routes or route groups. This is the exact pattern you'll implement today.

You already know JWT conceptually from Project Camp. You are only learning the Fastify-specific API today, not JWT itself.

---

### Build Block — 4h

**Step 1 — Install `@fastify/jwt` and configure (20 min)**

```bash
npm install @fastify/jwt
```

In `app.ts`, register before any routes:
```typescript
import jwt from '@fastify/jwt'
await app.register(jwt, {
  secret: env.JWT_SECRET,
  sign: { expiresIn: '15m' }
})
```

**Step 2 — Add `authenticate` preHandler (20 min)**

Create `src/plugins/authenticate.ts`:
```typescript
import { FastifyRequest, FastifyReply } from 'fastify'

export async function authenticate(request: FastifyRequest, reply: FastifyReply) {
  try {
    await request.jwtVerify()
  } catch {
    return reply.unauthorized('Invalid or expired token')
  }
}
```

**Step 3 — Login endpoint (1h)**

Add to `src/services/auth.service.ts`:
```typescript
import { FastifyInstance } from 'fastify'

// Add this method to authService:
async login(email: string, password: string, app: FastifyInstance) {
  const user = await userRepository.findByEmail(email)
  if (!user) throw new Error('INVALID_CREDENTIALS')

  const passwordValid = await argon2.verify(user.passwordHash, password)
  if (!passwordValid) throw new Error('INVALID_CREDENTIALS')

  if (!user.isVerified) throw new Error('EMAIL_NOT_VERIFIED')

  // Access token — short lived
  const accessToken = app.jwt.sign({
    sub: user.id,
    tenantId: user.tenantId,
    role: user.role,
  })

  // Refresh token — long lived, stored as hash
  const rawRefreshToken = crypto.randomBytes(32).toString('base64url')
  const refreshTokenHash = await argon2.hash(rawRefreshToken)
  await userRepository.updateRefreshTokenHash(user.id, refreshTokenHash)

  return {
    accessToken,
    refreshToken: rawRefreshToken,
    expiresIn: 900,  // 15 minutes in seconds
  }
},

async refresh(userId: string, rawRefreshToken: string, app: FastifyInstance) {
  const user = await userRepository.findById(userId, /* any tenantId - we verify below */ '')
  // Note: for refresh, we find by userId directly since we don't have tenantId yet
  // Use a different repo query here - findByIdOnly
  if (!user || !user.refreshTokenHash) throw new Error('INVALID_REFRESH_TOKEN')

  const valid = await argon2.verify(user.refreshTokenHash, rawRefreshToken)
  if (!valid) throw new Error('INVALID_REFRESH_TOKEN')

  const accessToken = app.jwt.sign({
    sub: user.id,
    tenantId: user.tenantId,
    role: user.role,
  })

  return { accessToken, expiresIn: 900 }
},

async logout(userId: string) {
  await userRepository.updateRefreshTokenHash(userId, null)
},
```

Add `findByIdOnly` to `user.repository.ts`:
```typescript
findByIdOnly: (id: string) =>
  prisma.user.findUnique({ where: { id } }),
```

**Step 4 — Login, refresh, logout routes (45 min)**

Create `src/routes/auth/login.ts`:
```typescript
// POST /auth/login
// POST /auth/refresh
// POST /auth/logout (requires authenticate preHandler)
```
Wire each to `authService.login()`, `authService.refresh()`, `authService.logout()`. Register in `app.ts` under `/auth` prefix.

**Step 5 — Create a protected test route (15 min)**

In `app.ts`, register a simple protected route to verify auth works:
```typescript
app.get(
  '/api/ping',
  { preHandler: [authenticate] },
  async (request) => {
    const user = request.user as { sub: string; tenantId: string; role: string }
    return { message: 'pong', userId: user.sub, tenantId: user.tenantId }
  }
)
```

Test manually: login → copy access token → `curl -H "Authorization: Bearer <token>" localhost:3000/api/ping`

**Step 6 — Tests (1h)**

Create `src/__tests__/auth.login.test.ts`:
```typescript
it('should return accessToken and refreshToken on valid credentials')
it('should return 401 for wrong password')
it('should return 401 for non-existent email')
it('should return 403 for unverified email')
it('should issue new accessToken with valid refreshToken')
it('should return 401 for invalid refreshToken')
it('should logout and invalidate the refreshToken (refresh fails after logout)')
it('should return 401 on GET /api/ping without a token')
it('should return 200 on GET /api/ping with a valid token')
it('should return 401 on GET /api/ping with an expired/tampered token')
```

**Step 7 — Git commit**
```bash
git commit -m "feat: JWT login, refresh token, logout — full auth flow complete"
```

---

### ✅ Day 4 End-of-Day Checkpoint

- [ ] Full flow works end-to-end: `register-tenant` → `verify-email` → `login` → receive tokens → `GET /api/ping` with token → `200 pong`
- [ ] `GET /api/ping` without token → `401`
- [ ] Refresh endpoint gives a new access token
- [ ] After logout, refresh token no longer works (returns `401`)
- [ ] `npm test` passes (aim for 20+ tests total)

---

## Day 5 — TenantContext Middleware: The Isolation Enforcement Layer

**Hours target:** 6h
**JIT Learning cap:** 1h
**End-of-day state:** Every request to any route in the authenticated scope has `request.tenantContext` populated with `{tenantId, userId, role}`. A `GET /api/me` endpoint proves this. SIGTERM gracefully shuts down BullMQ + Redis + Fastify.

> **This is the most architecturally critical day of the week.** Do not start the build block until the full reading block is done. The mental model here will affect every line of code you write for the rest of the project.

---

### JIT Learning Block — 1h (read all three before writing any code)

**Resource 1 — Fastify Hooks (re-read with purpose) (25 min)**
URL: https://fastify.dev/docs/latest/reference/Hooks/
This time, read with a specific question in mind: *"Where in the lifecycle does my TenantContext middleware run?"*
Answer: it runs as a `preHandler` hook, after JWT verification. The JWT `authenticate` function runs first (also a `preHandler`), sets `request.user`, and then `attachTenantContext` reads from `request.user` and sets `request.tenantContext`.
Read the lifecycle order diagram and the `preHandler` section carefully.

**Resource 2 — Fastify Decorators (20 min)**
URL: https://fastify.dev/docs/latest/reference/Decorators/
Read: "decorateRequest" section specifically.
**What to absorb:** Before you can do `request.tenantContext = {...}`, you must declare the property with `fastify.decorateRequest('tenantContext', null)`. Without this declaration, TypeScript will complain and Fastify's schema serialization may behave unexpectedly. The decorator declaration goes in a plugin file registered before any routes.

**Resource 3 — Fastify Plugin Encapsulation (15 min)**
URL: https://fastify.dev/docs/latest/guides/Plugins-Guide/
Read: "Encapsulation" section only.
**What to absorb:** Routes registered inside a `fastify.register(async fn => {...})` callback inherit hooks and plugins registered inside that callback, but not routes outside it. This is how you apply `authenticate` + `attachTenantContext` to all protected routes at once, without touching public routes like `/auth/login`.

---

### Build Block — 5h

**Step 1 — TypeScript type augmentation (20 min)**

Create `src/types/fastify.d.ts`:
```typescript
import 'fastify'

export interface TenantContext {
  userId: string
  tenantId: string
  role: string
}

declare module 'fastify' {
  interface FastifyRequest {
    tenantContext: TenantContext
  }
}
```

This tells TypeScript that every `FastifyRequest` has a `tenantContext` property. Without this, TypeScript will complain every time you access `request.tenantContext`.

**Step 2 — TenantContext plugin (30 min)**

Create `src/plugins/tenant-context.plugin.ts`:
```typescript
import fp from 'fastify-plugin'

export default fp(async function tenantContextPlugin(fastify) {
  // Declare the decorator — must happen before any route uses it
  fastify.decorateRequest('tenantContext', null)
})
```

`fp()` (fastify-plugin) makes the decorator available globally, not just inside the plugin's scope. Register this in `app.ts` as the very first plugin, before anything else.

**Step 3 — `attachTenantContext` hook (20 min)**

Add to `src/plugins/authenticate.ts`:
```typescript
import { FastifyRequest, FastifyReply } from 'fastify'

export async function authenticate(request: FastifyRequest, reply: FastifyReply) {
  try {
    await request.jwtVerify()
  } catch {
    return reply.unauthorized('Invalid or expired token')
  }
}

export async function attachTenantContext(request: FastifyRequest, reply: FastifyReply) {
  const payload = request.user as { sub: string; tenantId: string; role: string }

  if (!payload?.sub || !payload?.tenantId) {
    return reply.unauthorized('Malformed token — missing required claims')
  }

  request.tenantContext = {
    userId: payload.sub,
    tenantId: payload.tenantId,
    role: payload.role,
  }
}
```

**Step 4 — Protected route scope in `app.ts` (45 min)**

This is the structural change that wires everything together. Refactor `app.ts`:

```typescript
import { authenticate, attachTenantContext } from './plugins/authenticate'
import tenantContextPlugin from './plugins/tenant-context.plugin'

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: { ... } })

  // ── Global plugins (available everywhere) ──────────────────────────
  await app.register(sensible)
  await app.register(jwt, { secret: env.JWT_SECRET, sign: { expiresIn: '15m' } })
  await app.register(tenantContextPlugin)  // Must be first

  // ── Public routes (no auth required) ───────────────────────────────
  app.get('/health', async () => ({ status: 'ok' }))
  app.register(registerRoutes, { prefix: '/auth' })
  app.register(loginRoutes, { prefix: '/auth' })

  // ── Protected routes (JWT + TenantContext required) ─────────────────
  app.register(async (scope) => {
    scope.addHook('preHandler', authenticate)
    scope.addHook('preHandler', attachTenantContext)

    // All authenticated routes go inside this scope
    scope.get('/me', async (request) => ({
      userId: request.tenantContext.userId,
      tenantId: request.tenantContext.tenantId,
      role: request.tenantContext.role,
    }))

    // Future routes (agents, tools, etc.) will be registered here
  }, { prefix: '/api' })

  return app
}
```

**Step 5 — Move `/api/ping` to `/api/me` inside the scope (10 min)**

Delete the standalone `/api/ping` route you added in Day 4 and replace it with `/api/me` inside the authenticated scope as shown above.

Test: login → `curl -H "Authorization: Bearer <token>" localhost:3000/api/me` → should return `{userId, tenantId, role}`.

**Step 6 — Graceful shutdown handler (30 min)**

In `src/server.ts`:
```typescript
import { emailWorker, emailQueue, redisConnection } from './workers/email.worker'

const app = await buildApp()

// Graceful shutdown
const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'Shutdown signal received')

  // Order matters:
  // 1. Stop accepting new connections
  await app.close()
  // 2. Drain BullMQ workers (finish current job, don't start new ones)
  await emailWorker.close()
  await emailQueue.close()
  // 3. Close Redis
  await redisConnection.quit()
  // 4. Close database (Prisma closes on process exit, but explicit is cleaner)
  await prisma.$disconnect()

  process.exit(0)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
```

**Step 7 — Tests for TenantContext (45 min)**

Create `src/__tests__/tenant-context.test.ts`:
```typescript
it('GET /api/me returns tenantContext for valid token')
it('GET /api/me returns 401 without any token')
it('GET /api/me returns 401 with expired token')
it('GET /api/me returns 401 with tampered token signature')
it('tenantId in response matches the tenantId from the registered tenant')
it('GET /auth/register-tenant is accessible without any token (public route)')
```

**Step 8 — Git commit**
```bash
git commit -m "feat: TenantContext middleware via Fastify hooks + decorators, graceful shutdown"
```

---

### ✅ Day 5 End-of-Day Checkpoint

- [ ] `GET /api/me` with a valid token returns the correct `{userId, tenantId, role}`
- [ ] `GET /api/me` without a token returns `401` — not `500`, not `404`
- [ ] Public routes (`/auth/login`, `/health`) are accessible without any token
- [ ] `SIGTERM` (Ctrl+C in dev) produces clean shutdown logs with no hanging process
- [ ] `npm test` passes (aim for 25+ tests)

---

## Day 6 — The Proof Checkpoint: Tenant Isolation Test

**Hours target:** 5h
**JIT Learning cap:** 30 min
**End-of-day state:** The Week 1 proof checkpoint test passes. Tenant A's JWT cannot access Tenant B's data under any circumstance. The entire auth flow is tested end-to-end in a single integration test.

> Today is deliberately about testing, not features. If all your checkpoints from Days 1–5 are solid, today should feel satisfying. If they aren't, use this day to fix them — do not add new features on top of a shaky foundation.

---

### JIT Learning Block — 30 min

**Resource — Fastify Testing Guide (30 min)**
URL: https://fastify.dev/docs/latest/guides/Testing/
Read the entire page — it's short.
**What to absorb:** `app.inject()` simulates HTTP requests without starting a TCP server. How to use `beforeAll` to start the app once for the whole test suite. How to properly close the app in `afterAll`. The difference between `app.ready()` and waiting for `app.listen()` in tests (you don't need `listen` in tests — `inject` handles it).

---

### Build Block — 4.5h

**Step 1 — Test database cleanup (30 min)**

Tests must not pollute each other. Create `src/__tests__/helpers/db.ts`:
```typescript
import { prisma } from '../../lib/prisma'

export async function cleanDatabase() {
  // Delete in reverse dependency order (users before tenants)
  await prisma.user.deleteMany()
  await prisma.tenant.deleteMany()
}
```

Create a Vitest global setup file. Add to `vitest.config.ts` (create this file):
```typescript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./src/__tests__/helpers/setup.ts'],
  },
})
```

Create `src/__tests__/helpers/setup.ts`:
```typescript
import { afterEach } from 'vitest'
import { cleanDatabase } from './db'

afterEach(async () => {
  await cleanDatabase()
})
```

This cleans the database after every test, ensuring test independence.

**Step 2 — Create a test helper for the full auth flow (30 min)**

Create `src/__tests__/helpers/auth.ts`:
```typescript
import { FastifyInstance } from 'fastify'

export async function registerAndLogin(
  app: FastifyInstance,
  tenantSlug: string,
  email: string,
  password = 'TestPassword123!'
) {
  // Register tenant
  await app.inject({
    method: 'POST',
    url: '/auth/register-tenant',
    payload: { tenantName: `Tenant ${tenantSlug}`, slug: tenantSlug, ownerEmail: email, password },
  })

  // Get the verification token from the database (bypass email in tests)
  const { prisma } = await import('../../lib/prisma')
  const user = await prisma.user.findUnique({ where: { email } })

  // Verify email
  await app.inject({
    method: 'GET',
    url: `/auth/verify-email?token=${user!.verificationToken}`,
  })

  // Login
  const loginRes = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password },
  })

  const { accessToken, refreshToken } = JSON.parse(loginRes.body)
  return { accessToken, refreshToken, userId: user!.id, tenantId: user!.tenantId }
}
```

**Step 3 — The Isolation Proof Test (1.5h)**

Create `src/__tests__/tenant-isolation.test.ts`:
```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { buildApp } from '../app'

describe('⛔ Tenant Isolation — Core Security Guarantee', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let tenantA: { accessToken: string; tenantId: string }
  let tenantB: { accessToken: string; tenantId: string }

  beforeAll(async () => {
    app = await buildApp()
    tenantA = await registerAndLogin(app, 'tenant-a', 'admin@tenant-a.com')
    tenantB = await registerAndLogin(app, 'tenant-b', 'admin@tenant-b.com')
  })

  afterAll(async () => { await app.close() })

  it('Tenant A JWT returns Tenant A data from /api/me', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { Authorization: `Bearer ${tenantA.accessToken}` },
    })
    const body = JSON.parse(res.body)
    expect(res.statusCode).toBe(200)
    expect(body.tenantId).toBe(tenantA.tenantId)
    expect(body.tenantId).not.toBe(tenantB.tenantId)
  })

  it('Tenant B JWT returns Tenant B data from /api/me (not Tenant A)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { Authorization: `Bearer ${tenantB.accessToken}` },
    })
    const body = JSON.parse(res.body)
    expect(body.tenantId).toBe(tenantB.tenantId)
    expect(body.tenantId).not.toBe(tenantA.tenantId)
  })

  it('Tenant A token is rejected on a request impersonating Tenant B tenantId', async () => {
    // Tenant A cannot manually set a different tenantId — it must come from the verified JWT
    const res = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: {
        Authorization: `Bearer ${tenantA.accessToken}`,
        'X-Tenant-Override': tenantB.tenantId,  // should be completely ignored
      },
    })
    const body = JSON.parse(res.body)
    // The tenantId must still be Tenant A's — headers cannot override JWT claims
    expect(body.tenantId).toBe(tenantA.tenantId)
  })

  it('A request with no token is rejected from all protected routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/me' })
    expect(res.statusCode).toBe(401)
  })

  it('A forged JWT with Tenant B tenantId is rejected (signature mismatch)', async () => {
    // Create a JWT signed with the wrong secret
    const fakeToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJmYWtlIiwidGVuYW50SWQiOiJ0ZW5hbnQtYiIsInJvbGUiOiJvd25lciJ9.invalidsignature'
    const res = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { Authorization: `Bearer ${fakeToken}` },
    })
    expect(res.statusCode).toBe(401)
  })
})
```

**Step 4 — End-to-end integration test (1h)**

Create `src/__tests__/auth.e2e.test.ts` — one test that walks the complete Week 1 flow:
```typescript
it('complete auth lifecycle: register → verify → login → access → refresh → logout → access fails', async () => {
  // 1. Register
  const regRes = await app.inject({ method: 'POST', url: '/auth/register-tenant', payload: {...} })
  expect(regRes.statusCode).toBe(201)

  // 2. Access protected route before verification
  // (login should fail with 403 if unverified)

  // 3. Verify email (get token from DB in test)

  // 4. Login — get tokens

  // 5. Access /api/me with access token — should work

  // 6. Refresh — get new access token

  // 7. Logout

  // 8. Try to refresh after logout — should fail 401

  // 9. Old access token still works until it expires (JWTs are stateless — this is correct)
})
```

**Step 5 — Code review pass (45 min)**

Go through every route you've written and check:
- [ ] Every database query in a protected route uses `request.tenantContext.tenantId` as a filter — never a raw ID from request body/params without verification
- [ ] No route response includes `passwordHash`, `verificationToken`, or `refreshTokenHash`
- [ ] Every route has JSON Schema validation on its request body
- [ ] Run `npx tsc --noEmit` — zero TypeScript errors

**Step 6 — Git commit**
```bash
git commit -m "test: Week 1 proof checkpoint — tenant isolation tests passing, full auth e2e"
```

---

### ✅ Day 6 End-of-Day Checkpoint (Week 1 Gate)

**All of these must pass before proceeding to Week 2:**
- [ ] `npm test` — all tests pass, including the isolation test file
- [ ] **Tenant A's JWT cannot return Tenant B's tenantId from any endpoint**
- [ ] Forged JWT is rejected
- [ ] No plaintext password or token in any API response
- [ ] `npx tsc --noEmit` — zero TypeScript errors

---

## Day 7 — Buffer, Hardening & Week 2 Preview

**Hours target:** 3–4h (lighter day by design)
**Goal:** Ship Week 1 complete. Fix anything that slipped. Set up a clean launchpad for Week 2.

---

### Block 1 — Catch-Up (0–2h, as needed)

If any Day 1–6 checkpoint is incomplete, fix it now. Do not carry technical debt into Week 2. The isolation proof test passing is the non-negotiable gate.

### Block 2 — Code Hardening (1h)

Go through the codebase with this checklist:
- [ ] Replace any remaining `console.log` with `app.log.info` or `app.log.error`
- [ ] Every error response uses `@fastify/sensible` methods (no raw `reply.status(400).send(...)`)
- [ ] Add error handling for database connection failures (what happens if Prisma can't connect on startup?)
- [ ] Verify `docker compose down && docker compose up -d && npm run dev` starts cleanly from scratch

### Block 3 — Week 2 Preview (30–45 min)

Read these — skim only, 15 min max each, no building:
- [`argon2` npm README](https://www.npmjs.com/package/argon2) — you'll use `hash()` + `verify()` for API keys in Week 2
- [Node.js `crypto.createCipheriv` docs](https://nodejs.org/api/crypto.html#cryptocreatecipher) — look at the AES-256-GCM code example at the bottom

The goal is not to learn these today. The goal is that Week 2 Day 1 starts with context, not a cold start.

### Block 4 — Cleanup and Documentation (30 min)

```bash
# Final Week 1 commit
git add .
git commit -m "chore: week 1 complete — multi-tenant auth, isolation proof passing"
```

Create or update `PROGRESS.md`:
```markdown
## Week 1 — Complete

### What was built
- Fastify + TypeScript scaffold with env validation (zod)
- PostgreSQL schema: tenants + users (Prisma)
- Tenant + user registration with argon2 password hashing
- Email verification via BullMQ stub worker
- JWT auth: login, refresh token, logout
- TenantContext middleware: Fastify hooks + decorators
- Graceful SIGTERM shutdown

### Proof checkpoint
- Tenant A JWT cannot access Tenant B data — tests pass
- Forged JWT rejected — tests pass
- No plaintext passwords in any DB column or API response — verified

### Deferred (planned for Week 2)
- Agent CRUD + API key generation
- Tool CRUD + AES-256 encryption of handler_config
```

---

## Week 1 Hours Summary

| Day | Focus | Target Hours |
|---|---|---|
| Day 1 | Fastify foundation + Vitest | 5–6h |
| Day 2 | PostgreSQL + Prisma + repositories | 5–6h |
| Day 3 | Registration + argon2 + BullMQ stub | 5–6h |
| Day 4 | JWT auth: login, refresh, logout | 5h |
| Day 5 | TenantContext middleware (critical day) | 6h |
| Day 6 | Isolation proof checkpoint + tests | 5h |
| Day 7 | Buffer + hardening + Week 2 preview | 3–4h |
| **Total** | | **34–39h** |

**On daily hours:** 5–6 net focused hours = approximately 7–8 clock hours including short breaks and compilation time. Do not try to push 10-hour days — quality collapses after 6 hours of focused work and you will introduce bugs you spend the next day undoing. Consistent 5–6 hour days across 8 weeks complete this project on time.

---

## Three Rules That Apply Every Single Day

**1. The reading cap is a hard stop, not a suggestion.**
Close the docs tab when the time cap hits. The gaps in your understanding fill in through building, not through more reading. You will get stuck — that is normal and expected. When you get stuck: try for 15 minutes on your own, then look at the relevant docs section, then ask.

**2. Tests are written the same day as the feature.**
Not the next day, not on Day 6. Each feature is only "done" when the test for it passes. This is not optional for a security-critical platform — a test that doesn't exist is a vulnerability that doesn't have a detection mechanism.

**3. Never proceed past a failing proof checkpoint.**
The Week 1 gate is the isolation test. If it doesn't pass, Week 2 does not start. This discipline is what makes the 2-month deadline achievable — compounding bugs from skipped checkpoints are what blow deadlines, not the work itself.

---

*Week 2 roadmap (Agent & Tool Registries + AES-256 encryption) will follow the same structure. It begins only after the Week 1 proof checkpoint passes.*