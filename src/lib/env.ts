import { z } from "zod";
import "dotenv/config";

const envSchema = z.object({
  AGENTGATE_DATABASE_URL: z.string().url(),
  AGENTGATE_REDIS_URL: z.string().url(),
  AGENTGATE_JWT_SECRET: z.string().min(32),
  AGENTGATE_PLATFORM_ENCRYPTION_KEY: z.string().length(64),
  AGENTGATE_PORT: z.coerce.number().default(4000),
  AGENTGATE_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  AGENTGATE_ENVIRONMENT: z.enum(["development", "production", "test"]).default("development"),

  //-------- SMTP -----------------

  // AGENTGATE_SMTP_HOST: z.string().default("localhost"),
  // AGENTGATE_SMTP_PORT: z.coerce.number().default(587),
  // AGENTGATE_SMTP_USER: z.string().default(""),
  // AGENTGATE_SMTP_PASS: z.string().default(""),

  // ---------- CORS AND RATE-LIMIT -------------
  // AGENTGATE_CORS_ORIGIN: z.string().default("http://localhost:5173"),
  // AGENTGATE_DEFAULT_RATE_LIMIT: z.coerce.number().default(60),

  // BullMQ (Week 3 — audit queue)
  // AGENTGATE_BULLMQ_PREFIX: z.string().default("agentgate"),

  // Audit retention (Week 5 — compliance)
  // AGENTGATE_AUDIT_RETENTION_DAYS: z.coerce.number().default(90),

  // Encryption key rotation identifier
  // AGENTGATE_ENCRYPTION_KEY_ID: z.string().default("v1"),

  //==============================================================================
  //===============================PRODUCTION=====================================

  // Error tracking
  // AGENTGATE_SENTRY_DSN: z.string().url().optional(),

  // External tool handler timeouts
  // AGENTGATE_TOOL_EXECUTION_TIMEOUT_MS: z.coerce.number().default(30000),
  // AGENTGATE_TOOL_MAX_RESPONSE_BYTES: z.coerce.number().default(10485760),  // 10MB

  // Session configuration (MCP SSE connection)
  // AGENTGATE_SSE_HEARTBEAT_INTERVAL_MS: z.coerce.number().default(15000),
  // AGENTGATE_SSE_SESSION_TTL_MS: z.coerce.number().default(300000),  // 5min idle disconnect


})

export const env = envSchema.parse(process.env)