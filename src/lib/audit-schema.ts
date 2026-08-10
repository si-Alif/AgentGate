import { z} from "zod";

const baseFields = {
  id: z.string().uuid(),
  schemaVersion: z.literal(1),
  tenantId: z.string(),
  timestamp: z.coerce.date(),
};

const invocationFields = {
  ...baseFields,
  agentId: z.string(),
  toolId: z.string(),
  durationMs: z.number().int().nonnegative(),
  startedAt: z.coerce.date(),
  completedAt: z.coerce.date(),
  inputPreview: z.unknown().optional(),
  outputPreview: z.unknown().optional(),
  inputTruncated: z.boolean(),
  outputTruncated: z.boolean(),
  errorCode: z.string().optional(),
  errorMessage: z.string().optional(),
};

const toolInvocationEventSchema = z.object({
  ...invocationFields,
  eventType: z.literal("TOOL_INVOCATION"),
  status: z.enum(["success", "error", "timeout", "payload_too_large", "unsupported_media_type" , "ssrf_blocked"]),
  gatewayOverheadMs : z.number().int().nonnegative().optional(),
  executeToolDbLookupMs: z.number().int().nonnegative().optional(),
});

// STUB — no caller until Week 6 wires checkPermission()'s denial path
// into the gateway. Typed now so that wiring is "add a caller," not
// "design a schema."
const permissionDeniedEventSchema = z.object({
  ...invocationFields,
  eventType: z.literal("PERMISSION_DENIED"),
  status: z.literal("denied"),
  denialReason: z.string(), // mirrors PermissionCheckResult's `reason` from Week 3
});

// STUB — same status, no caller until Week 6.
const rateLimitedEventSchema = z.object({
  ...invocationFields,
  eventType: z.literal("RATE_LIMITED"),
  status: z.literal("rate_limited"),
});

// STUB — NOT invocation-shaped: no toolId, no status, no duration.
// Writes audit_events only. No caller until a Week 6+ producer exists.
const agentAuthenticatedEventSchema = z.object({
  ...baseFields,
  eventType: z.literal("AGENT_AUTHENTICATED"),
  agentId: z.string(),
});

export const auditJobPayloadSchema = z.discriminatedUnion("eventType", [
  toolInvocationEventSchema,
  permissionDeniedEventSchema,
  rateLimitedEventSchema,
  agentAuthenticatedEventSchema,
]);


export type AuditJobPayload = z.infer<typeof auditJobPayloadSchema>;
export type ToolInvocationJobPayload = z.infer<typeof toolInvocationEventSchema>;

export type PermissionDeniedJobPayload = z.infer<typeof permissionDeniedEventSchema>;
export type RateLimitedJobPayload = z.infer<typeof rateLimitedEventSchema>;

export const INVOCATION_EVENT_TYPES = ["TOOL_INVOCATION", "PERMISSION_DENIED", "RATE_LIMITED"] as const;

type InvocationShapedPayload = Extract<
  AuditJobPayload,
  { eventType: (typeof INVOCATION_EVENT_TYPES)[number] }
>;

export function isInvocationShapedEvent(payload: AuditJobPayload): payload is InvocationShapedPayload {
  return (INVOCATION_EVENT_TYPES as readonly string[]).includes(payload.eventType);
}