import { z } from "zod";
import "dotenv/config";

const envSchema = z.object({
  AGENTGATE_DATABASE_URL: z.string().url(),
  AGENTGATE_REDIS_URL: z.string().url(),
  AGENTGATE_JWT_SECRET: z.string().min(32),
  AGENTGATE_PLATFORM_ENCRYPTION_KEY: z.string().length(64),
  AGENTGATE_PORT: z.coerce.number().default(4000),
  AGENTGATE_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  AGENTGATE_NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

  // ═══════════════════════════════════════════════════════
  // Week 1 — SMTP (uncomment when email verification is built)
  // ═══════════════════════════════════════════════════════
  // AGENTGATE_SMTP_HOST: z.string().default("localhost"),
  // AGENTGATE_SMTP_PORT: z.coerce.number().default(587),
  // AGENTGATE_SMTP_USER: z.string().default(""),
  // AGENTGATE_SMTP_PASS: z.string().default(""),

  // ═══════════════════════════════════════════════════════
  // Week 3 — Rate limiting & CORS
  // ═══════════════════════════════════════════════════════
  // AGENTGATE_CORS_ORIGIN: z.string().default("http://localhost:5173"),
  // AGENTGATE_DEFAULT_RATE_LIMIT: z.coerce.number().default(60),

  // ═══════════════════════════════════════════════════════
  // Week 3 — BullMQ
  // ═══════════════════════════════════════════════════════
  // AGENTGATE_BULLMQ_PREFIX: z.string().default("agentgate"),

  // ═══════════════════════════════════════════════════════
  // Week 5 — Audit compliance
  // ═══════════════════════════════════════════════════════
  // AGENTGATE_AUDIT_RETENTION_DAYS: z.coerce.number().default(90),
});

export const env = envSchema.parse(process.env);

export type Env = z.infer<typeof envSchema>;