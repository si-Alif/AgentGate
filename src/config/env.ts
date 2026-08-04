import { z } from "zod";
import "dotenv/config";

const envSchema = z.object({
  AGENTGATE_DATABASE_URL: z.string().url(),
  AGENTGATE_REDIS_URL: z.string().url(),
  AGENTGATE_JWT_SECRET: z.string().min(32),

  // Argo2 password "secret" (pepper) in hex (32 bytes => 64 hex chars)
  AGENTGATE_PASSWORD_PEPPER: z.string().length(64),
  AGENTGATE_API_KEY_PEPPER: z.string().length(64),

  // Refresh-token HMAC lookup secret in hex (32 bytes => 64 hex chars)
  AGENTGATE_REFRESH_TOKEN_SECRET: z.string().length(64),

  AGENTGATE_PLATFORM_ENCRYPTION_KEY: z.string().length(64),
  AGENTGATE_PORT: z.coerce.number().default(4000),
  AGENTGATE_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  AGENTGATE_NODE_ENV: z.enum(["development", "production", "test"]).default("development"),


  // ── Email delivery (closes Finding W8-1) ──────────────────────────
  AGENTGATE_EMAIL_PROVIDER: z.enum(["console", "sendgrid"]).default("console"),
  AGENTGATE_SENDGRID_API_KEY: z.string().min(1).optional(),
  AGENTGATE_EMAIL_FROM_ADDRESS: z.string().email().default("noreply@agentgate.dev"),
  AGENTGATE_EMAIL_FROM_NAME: z.string().min(1).default("AgentGate"),
  AGENTGATE_APP_BASE_URL: z.string().url(), // no default — a mailed link needs a real origin
  AGENTGATE_EMAIL_WORKER_CONCURRENCY: z.coerce.number().int().positive().default(5),


  // ═══════════════════════════════════════════════════════
  // Week 3 — Rate limiting & CORS
  // ═══════════════════════════════════════════════════════
  // AGENTGATE_CORS_ORIGIN: z.string().default("http://localhost:5173"),
  // AGENTGATE_DEFAULT_RATE_LIMIT: z.coerce.number().default(60),

  AGENTGATE_DB_POOL_MAX: z.coerce.number().default(10),
  AGENTGATE_AUDIT_DB_POOL_MAX: z.coerce.number().int().positive().default(5),
  AGENTGATE_AUDIT_PREVIEW_MAX_BYTES: z.coerce.number().default(8192),
  AGENTGATE_PUBLIC_AUTH_RATE_LIMIT: z.coerce.number().int().positive().default(20), // per minute, per (IP, route)


  // ═══════════════════════════════════════════════════════
  // Week 5 — Audit compliance
  // ═══════════════════════════════════════════════════════
  // AGENTGATE_AUDIT_RETENTION_DAYS: z.coerce.number().default(90),
  // add alongside the existing AGENTGATE_ variables
  AGENTGATE_MCP_ALLOWED_ORIGINS: z
    .string()
    .default("")
    .transform((val) => val.split(",").map((s) => s.trim()).filter(Boolean)),
  AGENTGATE_MCP_AUTH_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(30),
  AGENTGATE_MCP_MESSAGE_RATE_LIMIT: z.coerce.number().int().positive().default(120), // coarse, per-minute, pre-auth
  AGENTGATE_MCP_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(40_000),
  AGENTGATE_MCP_TOOLS_LIST_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(30),
  AGENTGATE_MCP_TOOL_CALL_RATE_LIMIT: z.coerce.number().int().positive().default(60),


  // observability
  AGENTGATE_WS_TICKET_TTL_SECONDS: z.coerce.number().int().positive().default(30),
  AGENTGATE_WS_TICKET_ISSUE_RATE_LIMIT: z.coerce.number().int().positive().default(10),
  AGENTGATE_WS_MAX_CONNECTIONS_PER_USER: z.coerce.number().int().positive().default(5),
  AGENTGATE_WS_STREAM_CONNECT_RATE_LIMIT: z.coerce.number().int().positive().default(30),
  AGENTGATE_WS_BACKPRESSURE_THRESHOLD_BYTES: z.coerce.number().int().positive().default(1_048_576),
  AGENTGATE_WS_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  AGENTGATE_TRUST_PROXY_HOPS: z.coerce.number().int().nonnegative().default(0),
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
export const env = envSchema.superRefine((val  , ctx)=>{
  if(val.AGENTGATE_EMAIL_PROVIDER === "sendgrid" && !val.AGENTGATE_SENDGRID_API_KEY){
    ctx.addIssue({
      code : z.ZodIssueCode.custom,
      path : ["AGENTGATE_SENDGRID_API_KEY"],
      message : "AGENTGATE_SENDGRID_API_KEY is required when AGENTGATE_EMAIL_PROVIDER is set to sendgrid"
    })
  }
  if (val.AGENTGATE_NODE_ENV === "production" && val.AGENTGATE_EMAIL_PROVIDER === "console") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path : ["AGENTGATE_EMAIL_PROVIDER"],
      message: "AGENTGATE_EMAIL_PROVIDER cannot be set to console in production",
    });
  }
}).parse(process.env);

function parseHexEnv(value: string, name: string) {
  if (!/^[0-9a-fA-F]+$/.test(value)) {
    throw new Error(`${name} must be valid hex`);
  }

  const buffer = Buffer.from(value, "hex");

  if (buffer.length !== 32) {
    throw new Error(`${name} must decode to 32 bytes`);
  }

  return buffer;
}

export const PASSWORD_PEPPER = parseHexEnv(env.AGENTGATE_PASSWORD_PEPPER, "AGENTGATE_PASSWORD_PEPPER");
export const API_KEY_PEPPER = parseHexEnv(env.AGENTGATE_API_KEY_PEPPER, "AGENTGATE_API_KEY_PEPPER");
export const PLATFORM_ENCRYPTION_KEY = parseHexEnv(
  env.AGENTGATE_PLATFORM_ENCRYPTION_KEY,
  "AGENTGATE_PLATFORM_ENCRYPTION_KEY"
);
export const REFRESH_TOKEN_SECRET = parseHexEnv(
  env.AGENTGATE_REFRESH_TOKEN_SECRET,
  "AGENTGATE_REFRESH_TOKEN_SECRET"
);

export type Env = z.infer<typeof envSchema>;
