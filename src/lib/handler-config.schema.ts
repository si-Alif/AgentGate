import {z} from 'zod';
import {checkHttpUrlSafety , checkPostgresConnectionStringSafety} from "./network-safety.js"

const MAX_CONFIG_STRING_LENGTH = 8_000;
const FORBIDDEN_HEADER_NAMES = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection"
]);

const CRLF_PATTERN = /[\r\n]/;


const safeHeaders = z
  .record(z.string() , z.string())
  .optional()
  .refine(
    (headers) => {
      if (!headers) return true;
      return Object.entries(headers).every(
        ([key, value]) => !FORBIDDEN_HEADER_NAMES.has(key.toLowerCase()) && !CRLF_PATTERN.test(value)
      );
    },
    { message: "headers must not override connection-level fields (Host, Content-Length, Transfer-Encoding, Connection) or contain CR/LF characters" }
  );

const safeHttpUrl = z
  .string()
  .max(MAX_CONFIG_STRING_LENGTH)
  .url()
  .superRefine((url, ctx) => {
    const result = checkHttpUrlSafety(url);
    if (!result.isSafe) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: result.reason ?? "URL target is not allowed" });
    }
  });

const safeConnectionString = z
  .string()
  .min(1)
  .max(MAX_CONFIG_STRING_LENGTH)
  .superRefine((cs, ctx) => {
    const result = checkPostgresConnectionStringSafety(cs);
    if (!result.isSafe) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: result.reason ?? "connection target is not allowed" });
    }
  });

export const httpHandlerConfigSchema = z
  .object({
    handlerType: z.literal("http"),
    url: safeHttpUrl,
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    headers: safeHeaders,
    bodyTemplate: z.string().max(MAX_CONFIG_STRING_LENGTH).optional(),
  })
  .strict();

export const postgresHandlerConfigSchema = z
  .object({
    handlerType: z.literal("postgres"),
    connectionString: safeConnectionString,
    query: z.string().min(1).max(MAX_CONFIG_STRING_LENGTH),
  })
  .strict();

export const webFetchHandlerConfigSchema = z
  .object({
    handlerType: z.literal("web_fetch"),
    url: safeHttpUrl,
  })
  .strict();

export const handlerConfigSchema = z.discriminatedUnion("handlerType", [
  httpHandlerConfigSchema,
  postgresHandlerConfigSchema,
  webFetchHandlerConfigSchema,
]);

export type HandlerConfig = z.infer<typeof handlerConfigSchema>;
