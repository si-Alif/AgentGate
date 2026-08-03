import { z } from "zod";

export const AUDIT_EVENT_TYPES = [
  "TOOL_INVOCATION",
  "PERMISSION_DENIED",
  "RATE_LIMITED",
  "AGENT_AUTHENTICATED",
] as const;

export const AUDIT_STATUSES = [
  "success",
  "error",
  "timeout",
  "payload_too_large",
  "unsupported_media_type",
  "denied",
  "rate_limited",
] as const;

/** The opaque cursor string validated after base64url decoding. */
export const auditCursorSchema = z.object({
  createdAt: z.number().int().positive(), // epoch ms
  id: z.string().uuid(),
});
export type AuditCursor = z.infer<typeof auditCursorSchema>;

/** Query string validation for the list endpoint. */
export const auditListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(25),
  cursor: z.string().optional(),
  eventType: z.enum(AUDIT_EVENT_TYPES).optional(),
  status: z.enum(AUDIT_STATUSES).optional(),
  agentId: z.string().optional(),
  toolId: z.string().optional(),
  since: z.coerce.date().optional(), // 
});
export type AuditListQuery = z.infer<typeof auditListQuerySchema>;