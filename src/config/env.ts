import { z } from "zod";
import "dotenv/config";

const envSchema = z.object({
  AGENTGATE_DATABASE_URL: z.string().url(),
  AGENTGATE_REDIS_URL: z.string().url(),
  AGENTGATE_JWT_SECRET: z.string().min(32),
  AGENTGATE_PASSWORD_PEPPER : z.string().length(64),
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


/**
#### workflow :
  1. dotenv library lokks for .env file in the root directory of the project and loads the environment variables from it into `process.env`.
    - `process.env` is just a giant object containing every environment variable on your system. dotenv simply adds your file's variables to that object.
  2. now that process.env contains all the variables from your .env file, we can use zod to validate them.
    - zod ignores all the variables that are not defined in the schema from `process.env` and only looks for the ones you have defined in your schema , loads them and then does the validation checks written against them
    - coercion : convert string into a number and validate
    - default : if var is missing in env , use the default value provided in the schema
  3. The result of `.parse()` is a plain JavaScript object that is fully typed. When you import env in server.ts, you aren't talking to the .env file anymore; you are talking to a validated, typed object in memory.
**/
export const env = envSchema.parse(process.env);

export const PASSWORD_PEPPER = Buffer.from(env.AGENTGATE_PASSWORD_PEPPER , "hex")

export type Env = z.infer<typeof envSchema>;