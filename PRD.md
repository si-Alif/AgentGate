# MCP Agent Infrastructure Platform — Project Blueprint

## Purpose of This Document

This document defines the full scope, phased plan, technical context, and intended outcomes for an MCP-compatible Agent Infrastructure Platform being built as a flagship backend engineering project. It is intended as a reference for system design, architecture decisions, and implementation planning. The reader should use this to produce a complete system design, data model, API surface, and phased execution plan.

---

## 1. One-Line Summary

A multi-tenant gateway platform that allows AI agents to securely authenticate, discover, and invoke registered tools against real systems — with enforced permissions, rate limits, audit logging, and real-time observability built in.

---

## 2. The Problem

When companies build AI agent workflows today, they face a structural problem. Giving an AI agent direct access to internal systems — databases, APIs, Slack, CRMs, internal tools — is dangerous. There is no controlled surface. The agent can call anything, with any parameters, with no audit trail, no rate limit, and no policy enforcement. When something goes wrong, there is no record of what happened.

The alternative — building custom integration code per agent per system — does not scale. Every new agent needs new integration work. Every new system needs new connectors. Permissions are hardcoded. Audit logs are an afterthought.

The core issue is that AI agents are not users. Users authenticate with usernames and passwords, operate through a UI, and are limited by what the UI exposes. Agents authenticate programmatically, can call anything callable, and operate at machine speed. Existing authentication and authorization patterns were not designed for this.

There is currently no standard infrastructure layer that solves this cleanly. Companies either skip it entirely (dangerous) or build it internally (expensive, one-off).

---

## 3. The Solution

An infrastructure platform that sits between AI agents and the systems they need to interact with.

```
AI Agent (Claude, GPT, Open Source)
          ↓
  MCP Protocol (SSE Transport)
          ↓
  Platform Gateway
  ┌───────────────────────┐
  │  Agent Authentication │
  │  Tool Discovery       │
  │  Authorization        │
  │  Rate Limiting        │
  │  Audit Logging        │
  │  Real-time Streaming  │
  └───────────────────────┘
          ↓
  Registered Tools (DB, Slack, API, etc.)
          ↓
  External Systems
```

The platform exposes a standard MCP-compatible interface. Any MCP-compatible AI agent connects to the platform the same way, regardless of the underlying systems. The platform handles all cross-cutting concerns — auth, permissions, rate limits, logging — so the agent only needs to know what tools exist and what they do.

---

## 4. Core Concepts and Terminology

**Tenant** A company or team using the platform. Tenants are fully isolated from each other. Each tenant has its own tool registry, agent registry, permissions, and audit log.

**User** A human who manages the platform for a tenant. Users authenticate with email/password + JWT. Users register tools, create agents, set permissions, and view audit logs through the management API or dashboard.

**Agent** An AI agent or automated system that calls tools through the platform. Agents authenticate with API keys. Agents are registered by users. Each agent has a defined set of tools it is permitted to use.

**Tool** A capability registered by a tenant. A tool is a named, typed action that the platform exposes via MCP. Tools can be: a database query, an HTTP call to an internal API, a Slack message, a file read, a search operation, or any callable action. Each tool has a schema (input parameters and return type) and an execution configuration (how the platform calls the underlying system).

**Tool Execution** One invocation of one tool by one agent. Each execution is an atomic, logged event with a unique ID, input parameters, output, timing, status, and attribution to the agent and tool that produced it.

**Permission** A declared allowance: agent X is permitted to call tool Y, optionally under specific conditions (parameter constraints, time windows, call limits).

**Audit Event** An immutable record of every significant action in the system: agent authenticated, tool invoked, permission denied, rate limit hit, tool registered, agent created. Audit events are append-only and never deleted.

**MCP Transport** The platform exposes tools over the MCP protocol using the HTTP + SSE (Server-Sent Events) transport. This is the standard MCP transport for remote servers. Agents connect to the platform endpoint, discover available tools via the MCP tool listing, and invoke them via JSON-RPC 2.0 messages over SSE.

---

## 5. Full Product Vision — End State

This section describes the complete product as it would exist after all phases are complete. This is the ultimate target, not the MVP.

### 5.1 Multi-Tenant Management

- Full tenant isolation at the data layer
- Tenant registration and onboarding flow
- User roles within a tenant: Owner, Admin, Member
- Tenant-level settings: rate limit defaults, audit retention period, allowed tool categories

### 5.2 Tool Registry

- CRUD for tools: create, update, deactivate, delete tools
- Tool schema definition: typed input parameters with validation rules, typed output schema
- Tool execution configuration: HTTP endpoint, database connection string, built-in handler type
- Tool versioning: tools can be updated without breaking agents using older versions
- Tool categories and tagging for discoverability
- Tool testing endpoint: invoke a tool manually from the dashboard to verify it works before exposing it to agents
- Tool marketplace: a curated library of pre-built tool templates (Slack, Postgres query, HTTP fetch, GitHub, Notion) that tenants can enable and configure without writing a handler

### 5.3 Agent Registry

- CRUD for agents: register, update, deactivate agents
- API key generation and rotation (keys are hashed and stored, never retrievable after creation)
- Agent metadata: name, description, owning user, creation date, last active
- Agent tool assignment: which tools a given agent is permitted to call

### 5.4 Authorization and Policy Engine

- Permission model: tenant → agent → tool → allowed/denied
- Parameter-level constraints: an agent can call a Postgres query tool only with read-only queries (enforced by parameter schema validation)
- Call budget per agent per tool: agent X can call tool Y at most N times per hour
- Time window restrictions: agent X can only call tool Y during defined time windows
- Emergency agent suspension: disable an agent immediately, all calls denied until re-enabled

### 5.5 Rate Limiting

- Global rate limit per tenant (total calls per minute across all agents)
- Per-agent rate limit (calls per minute for a specific agent)
- Per-tool rate limit (calls per minute against a specific tool)
- Rate limit headers returned on every tool invocation response
- Rate limit events logged as audit events
- Configurable rate limit tiers per tenant plan

### 5.6 Audit Log

- Immutable, append-only record of all significant events
- Events include: tool invocations (input, output, duration, status), permission denials, rate limit hits, agent authentication, agent creation, tool registration, user actions
- Full-text search over audit events
- Filtering by agent, tool, event type, time range, status
- Export to JSON or CSV
- Configurable retention period per tenant

### 5.7 MCP-Compatible Gateway

- Full implementation of the MCP server protocol (HTTP + SSE transport)
- MCP tool discovery endpoint: agents can list all tools they are permitted to call
- MCP tool invocation: agents invoke tools via JSON-RPC 2.0 over SSE
- MCP authentication: agent API key passed as Bearer token in Authorization header
- MCP error responses: standard JSON-RPC error codes plus platform-specific error types
- Connection management: SSE connection lifecycle, heartbeat, reconnect handling

### 5.8 Real-Time Observability

- WebSocket stream for live tool execution events (for dashboard consumers)
- Live view: which agents are active, which tools are being called, call success rate
- Per-agent activity timeline
- Per-tool call frequency graph
- Error rate monitoring with alerting (webhook or email notification when error rate exceeds threshold)
- p50/p95/p99 latency per tool

### 5.9 Built-In Tool Handlers

Pre-built execution handlers that tenants can configure without writing custom code:

- **HTTP Tool**: call any HTTP endpoint with configurable method, headers, body template
- **PostgreSQL Query Tool**: execute a SQL query against a configured database connection
- **Slack Tool**: send a message to a configured Slack channel via webhook
- **Web Fetch Tool**: fetch and return the text content of a public URL
- **Email Tool**: send a transactional email via SMTP or SendGrid

### 5.10 Workflow Execution (Post-MVP)

- Chain tools into named workflows: tool A output feeds into tool B input
- Workflow definition via JSON or YAML
- Parallel tool execution within a workflow
- Conditional branching: if tool A returns X, run tool B, else run tool C
- Workflow execution history and replay

### 5.11 SDK and Developer Experience

- TypeScript/Node.js SDK for registering custom tool handlers programmatically
- OpenAPI spec auto-generated from the management API
- Postman collection for the management API
- Getting-started guide with working examples for Claude and open-source MCP agents
- Self-hosted deployment option via Docker Compose

---

## 6. Technology Stack — Decisions and Rationale

|Technology|Choice|Rationale|
|---|---|---|
|Language|TypeScript (strict)|Type safety is non-negotiable for a platform other systems consume. Catches protocol contract violations at compile time.|
|Runtime|Node.js 22 LTS|Async I/O strengths align with gateway use case. MCP ecosystem is JavaScript-first. Existing familiarity.|
|Framework|Fastify|Better TypeScript support than Express. Built-in schema validation via JSON Schema. Plugin architecture. Measurably better performance for a gateway workload.|
|Primary Database|PostgreSQL|All core data is relational: tenants, agents, tools, permissions, audit events. Foreign key integrity matters. PostgreSQL's row-level security options suit multi-tenancy.|
|ORM|Prisma|TypeScript-first. Auto-generated types. Migration management. Readable schema definition file.|
|Cache and Queue|Redis + BullMQ|Redis for rate limit counters (atomic increments) and short-lived session state. BullMQ for async job processing (audit event writes, webhook deliveries).|
|Real-Time|SSE (MCP transport) + WebSocket (dashboard)|SSE is the standard MCP HTTP transport. WebSocket is appropriate for the dashboard observability stream where bidirectional is useful.|
|MCP Protocol|@modelcontextprotocol/sdk|Official SDK. Handles protocol framing, tool discovery, and SSE transport.|
|Authentication|API Keys (agents) + JWT (users)|Agents are not interactive — API keys are appropriate. Users are interactive — JWT is appropriate. These are different auth models for different consumers.|
|Testing|Vitest + Supertest|Vitest for unit tests. Supertest for integration tests against the Fastify app.|
|Deployment|Docker + Railway or Render|Container-based deployment. Environment parity between local and production.|

---

## 7. MVP — 2 Months

### Goal

A working, deployed platform that demonstrates the core value proposition end to end. An MCP- compatible AI agent can connect, authenticate, discover tools, invoke them, and every action is logged and rate-limited. Multi-tenancy is functional. A management API exists for all core operations.

### What Is Included in the MVP

**Tenant and User Management**

- Tenant registration
- User registration within a tenant (email + password)
- Email verification flow (BullMQ-queued email delivery)
- JWT-based user authentication (access token + refresh token)
- Basic user roles: Owner and Member

**Agent Management**

- Create, read, update, deactivate agents within a tenant
- API key generation on agent creation (shown once, stored as hash)
- API key rotation

**Tool Registry**

- Create, read, update, deactivate tools within a tenant
- Tool schema definition: name, description, input parameter schema (JSON Schema), output schema
- Tool execution configuration: HTTP handler or built-in handler type

**Built-In Tool Handlers (MVP — 3 tools)**

- HTTP Tool: configurable URL, method, headers, body template
- PostgreSQL Query Tool: configurable connection string, parameterized query execution
- Web Fetch Tool: fetch and return content of a public URL

**Authorization**

- Assign tools to agents: agent X is permitted to call tool Y
- All tool invocations check permission before execution
- Permission denied responses are logged and returned as MCP-standard errors

**Rate Limiting**

- Per-agent rate limit: configurable calls per minute, enforced via Redis atomic counter
- Rate limit exceeded returns standard MCP error response
- Rate limit events written to audit log

**MCP Gateway**

- MCP-compatible HTTP + SSE endpoint
- Agent authenticates via API key (Bearer token)
- MCP tool discovery: agent lists tools it is permitted to call
- MCP tool invocation: agent calls tool via JSON-RPC 2.0 over SSE
- Invocation routes to correct handler, enforces permission and rate limit, returns result

**Audit Log**

- Every tool invocation logged: agent ID, tool ID, tenant ID, input params, output, duration, status (success/error/denied), timestamp
- Every permission denial logged
- Every rate limit hit logged
- Read endpoint: list audit events with filtering by agent, tool, status, time range

**Real-Time Execution Stream**

- WebSocket endpoint that streams live tool execution events
- Authenticated by user JWT
- Scoped to the requesting user's tenant
- Emits event on every tool invocation start and completion

**Management REST API**

- Full CRUD for tenants, users, agents, tools, permissions
- Audit log query endpoint
- All endpoints behind JWT authentication
- All endpoints scoped to the requesting user's tenant (strict isolation)

**Deployment**

- Dockerized application
- PostgreSQL and Redis as external services
- Environment variable configuration
- Health check endpoint
- Deployed to Railway or Render with a live public URL
- README with setup instructions and working curl examples

### What Is Explicitly Excluded from the MVP

- Workflow chaining (tool A output into tool B)
- Parameter-level constraints on permissions
- Time window restrictions on permissions
- Tool marketplace or pre-built templates
- SDK
- Dashboard UI (management is API-only in MVP)
- Tool versioning
- Export of audit logs
- Webhook or email alerting on errors
- Latency percentile tracking
- Multiple auth methods beyond API key + JWT

### MVP Success Metrics

- An MCP-compatible agent (e.g., a script using the MCP SDK) can connect to the deployed platform, list tools, and invoke a tool end to end
- Tool invocations complete with p95 latency under 300ms (excluding the time taken by the underlying system the tool calls)
- Permission denial is enforced correctly: an agent without permission for a tool receives a standard MCP error response and the denial is in the audit log
- Rate limiting fires correctly and is reflected in the audit log
- All data is strictly tenant-isolated: an API key from tenant A cannot see or call anything belonging to tenant B
- Audit log captures every invocation with correct attribution

---

## 8. Phase 2 — Months 3 and 4

### Goal

Harden the authorization model, improve observability, add two more built-in tool handlers, and introduce the beginning of the developer experience layer.

### What Gets Added

**Advanced Authorization**

- Parameter-level constraints: define allowed parameter values or patterns per agent per tool
- Call budget: agent X can call tool Y at most N times per hour (enforced via Redis, logged when budget is exhausted)
- Emergency suspension: disable an agent immediately via API

**Slack Tool** (fourth built-in handler)

- Send message to configured Slack channel via incoming webhook
- Configurable channel, message template with parameter interpolation

**Email Tool** (fifth built-in handler)

- Send transactional email via SMTP or SendGrid
- Configurable recipient, subject template, body template

**Observability**

- p50 / p95 / p99 latency tracking per tool (rolling 1-hour window via Redis sorted set)
- Error rate per tool (rolling 1-hour window)
- Latency and error rate exposed via management API

**Audit Log Improvements**

- Full-text search over audit events (PostgreSQL full-text index)
- Export audit events as JSON

**OpenAPI Specification**

- Auto-generated OpenAPI spec for the management REST API
- Postman collection derived from the spec

**Testing**

- Integration test suite covering all core flows: agent auth, tool invocation, permission denial, rate limit enforcement, tenant isolation
- Tests run in CI on every push

---

## 9. Phase 3 — Months 5 and 6

### Goal

Introduce workflow execution, the tool marketplace concept, and self-hosted deployment option. At this point the platform is a complete, deployable product.

### What Gets Added

**Workflow Execution**

- Workflow definition: ordered list of tool invocations with input/output mapping between steps
- Workflow stored as a named, versioned entity in the tool registry
- Workflow invocation via MCP (a workflow appears as a tool to the agent)
- Sequential execution: each step's output maps to the next step's input
- Workflow execution record: full history of each step's input, output, status, and duration
- Failed step handling: configurable abort or continue on step failure

**Tool Marketplace (MVP Version)**

- Curated list of tool templates: Postgres query, HTTP call, Slack, Email, Web Fetch, GitHub issue create, Notion page create
- Tenant enables a template and provides configuration (connection string, API key, etc.)
- Template instantiates as a fully configured tool in the tenant's registry

**Self-Hosted Deployment**

- Docker Compose file with platform, PostgreSQL, and Redis
- Environment variable documentation
- Migration run on startup
- Self-hosted setup guide

**SDK (Alpha)**

- TypeScript package for registering a custom tool handler that connects to the platform
- Custom handlers run on the tenant's infrastructure and receive invocation requests from the platform via webhook
- SDK handles authentication, schema validation, and response formatting

---

## 10. Data Model — Key Entities

The following are the primary entities. The system design phase should produce the full schema including indexes, constraints, and foreign keys.

**tenants** — id, name, slug, plan, settings (rate limit defaults, audit retention), created_at

**users** — id, tenant_id, email, password_hash, role (owner/admin/member), is_verified, created_at

**agents** — id, tenant_id, name, description, api_key_hash, is_active, created_by, created_at, last_active_at

**tools** — id, tenant_id, name, description, category, handler_type (http/postgres/web_fetch/ slack/email/custom), handler_config (encrypted JSON), input_schema (JSON Schema), output_schema (JSON Schema), is_active, created_at, updated_at

**agent_tool_permissions** — id, agent_id, tool_id, tenant_id, parameter_constraints (JSON), call_budget_per_hour, is_active, created_at

**tool_executions** — id, tenant_id, agent_id, tool_id, input_params (JSON), output (JSON), status (success/error/denied/rate_limited), duration_ms, error_message, started_at, completed_at

**audit_events** — id, tenant_id, agent_id (nullable), user_id (nullable), tool_id (nullable), event_type, payload (JSON), created_at

**workflows** (Phase 3) — id, tenant_id, name, definition (JSON), version, is_active, created_at

**workflow_executions** (Phase 3) — id, workflow_id, tenant_id, agent_id, status, steps (JSON array of step results), started_at, completed_at

---

## 11. API Surface — Key Groups

The system design phase should expand these into full endpoint definitions.

**Auth** — register tenant, register user, verify email, login, refresh token, logout

**Agents** — CRUD, generate API key, rotate API key, suspend, list tools assigned

**Tools** — CRUD, assign to agent, remove from agent, test invocation, list executions

**MCP Gateway** — SSE connection endpoint (MCP transport), tool discovery, tool invocation (all JSON-RPC 2.0 over SSE, agent API key auth)

**Audit Log** — list events with filters, export, search

**Observability** — live WebSocket stream (user JWT auth), latency stats per tool, error rate per tool

**Workflows** (Phase 3) — CRUD, invoke, list executions, get execution detail

**Marketplace** (Phase 3) — list templates, enable template, configure enabled template

---

## 12. Non-Functional Requirements

**Security**

- API keys stored as bcrypt or Argon2 hashes, never in plaintext
- Tool handler configurations (connection strings, API keys for external services) encrypted at rest using AES-256
- All tenant data access goes through a tenant context middleware that enforces isolation
- Rate limit counters use Redis atomic INCR operations to prevent race conditions
- Audit log is append-only at the application layer (no update or delete endpoints)

**Performance Targets (MVP)**

- Tool invocation gateway overhead (excluding underlying system call): p95 under 300ms
- Audit event write: async via BullMQ, does not block invocation response
- Rate limit check: Redis operation, under 5ms

**Observability (Self)**

- Structured JSON logging via pino (built into Fastify)
- Request ID on every request, propagated to audit events
- Health check endpoint returning database and Redis connectivity status

---

## 13. What This Project Demonstrates Professionally

**Platform engineering** — exposing capabilities to other systems, not just end users. This is a different engineering layer from application development.

**Protocol implementation** — implementing MCP (JSON-RPC 2.0 over SSE) correctly requires understanding the protocol contract, not just calling an API.

**Multi-tenancy design** — strict data isolation, tenant-scoped auth, per-tenant configuration.

**Agent-level auth and authorization** — distinguishing agent identity from user identity and building authorization that works at machine speed, not human speed.

**Async job processing** — BullMQ queues for non-blocking audit writes and email delivery.

**Real-time streaming** — SSE for the MCP transport, WebSocket for the observability stream.

**Rate limiting under concurrency** — Redis atomic operations for correct behavior under concurrent agent calls.

**Security at the infrastructure layer** — encrypted configs, hashed keys, append-only audit, tenant isolation enforced in middleware.

**Measurable outcomes** — the same rigor applied in Summerizer: gateway overhead latency, rate limit accuracy, concurrent agent handling, tool invocation success rates.

---

## 14. What This Is Not

This is not a chatbot. This is not an LLM wrapper. This is not a workflow automation tool like n8n that end users operate through a UI. This is not a RAG pipeline (Summerizer already covers that).

This is backend infrastructure — a controlled, observable, permissioned service layer that AI agents consume the same way applications consume an API gateway. The AI aspect is in the consumers of the platform, not in the platform itself. The platform has no opinions about what model is calling it.

---

## 15. Intended Reader of This Document

A system design AI or architect should use this document to produce:

1. Complete PostgreSQL schema with all tables, indexes, constraints, and foreign keys
2. Full API specification for all endpoint groups (method, path, auth, request body, response body, error responses)
3. MCP gateway implementation plan (SSE connection lifecycle, JSON-RPC message handling, tool discovery protocol, invocation protocol)
4. Rate limiting implementation detail (Redis data structures, key naming, atomic operations, expiry strategy)
5. Multi-tenancy enforcement strategy (middleware design, query-level filtering, encryption approach for handler configs)
6. BullMQ queue design (queues, workers, retry strategy, dead letter handling)
7. WebSocket observability stream design (connection management, event schema, backpressure)
8. Phased implementation order within the MVP: what to build first given dependencies between components
9. Testing strategy: unit test targets, integration test scenarios, test data management
10. Deployment architecture: Docker setup, environment variables, migration strategy, health checks