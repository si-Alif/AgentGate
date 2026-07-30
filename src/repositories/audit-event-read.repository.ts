import { prisma } from "../lib/prisma.js";
import type { AuditListQuery, AuditCursor } from "../lib/audit-read-schemas.js";
import { INVOCATION_EVENT_TYPES } from "../lib/audit-schema.js";

const ERROR_CAP_LIST = 200;
const ERROR_CAP_DETAIL = 4_000;

export interface AuditEventListRow {
  id: string;
  eventType: string;
  agentId: string | null;
  toolId: string | null;
  status: string | null;
  createdAt: string;
  schemaVersion: number;
  hasInputPreview: boolean;
  hasOutputPreview: boolean;
  errorMessage: string | null;
}

export interface AuditEventListPage {
  data: AuditEventListRow[];
  nextCursor: string | null;
}

export async function listAuditEvents(
  tenantId: string,
  query: AuditListQuery,
  cursor?: AuditCursor
): Promise<AuditEventListPage> {
  const where: any = { tenantId };
  if (query.eventType) where.eventType = query.eventType;
  if (query.agentId) where.agentId = query.agentId;
  if (query.toolId) where.toolId = query.toolId;
  if (query.status) where.status = query.status;

  if (cursor) {
    const cursorDate = new Date(cursor.createdAt);
    // Keyset pagination: (createdAt DESC, id DESC)
    where.OR = [
      { createdAt: { lt: cursorDate } },
      {
        createdAt: cursorDate,
        id: { lt: cursor.id },
      },
    ];
  }

  const rows = await prisma.auditEvent.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: query.limit + 1, // one extra to detect next page
  });

  const hasMore = rows.length > query.limit;
  const pageRows = hasMore ? rows.slice(0, query.limit) : rows;

  // In‑memory join: one bulk lookup for invocation‑shaped events only
  const invocationIds = pageRows
    .filter((r) => (INVOCATION_EVENT_TYPES as readonly string[]).includes(r.eventType))
    .map((r) => r.id);

  const executions =
    invocationIds.length > 0
      ? await prisma.toolExecution.findMany({
        where: { id: { in: invocationIds }, tenantId },
      })
      : [];

  const executionById = new Map(executions.map((e) => [e.id, e]));

  const data: AuditEventListRow[] = pageRows.map((row) => {
    const exec = executionById.get(row.id);
    const schemaVersion = (row.payload as any)?.schemaVersion ?? 1;

    return {
      id: row.id,
      eventType: row.eventType,
      agentId: row.agentId,
      toolId: row.toolId,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      schemaVersion,
      hasInputPreview: !!exec?.inputPreview,
      hasOutputPreview: !!exec?.outputPreview,
      errorMessage: exec?.errorMessage
        ? exec.errorMessage.substring(0, ERROR_CAP_LIST)
        : null,
    };
  });

  let nextCursor: string | null = null;
  if (hasMore) {
    const last = pageRows[pageRows.length - 1]!;
    nextCursor = Buffer.from(
      JSON.stringify({ createdAt: last.createdAt.getTime(), id: last.id })
    ).toString("base64url");
  }

  return { data, nextCursor };
}

export async function getAuditEventDetail(
  tenantId: string,
  id: string
) {
  const event = await prisma.auditEvent.findFirst({
    where: { id, tenantId },
  });
  if (!event) return null;

  const isInvocation = (INVOCATION_EVENT_TYPES as readonly string[]).includes(event.eventType);

  let execution = null;
  if (isInvocation) {
    execution = await prisma.toolExecution.findFirst({
      where: { id: event.id, tenantId },
    });
  }

  return {
    id: event.id,
    tenantId: event.tenantId,
    eventType: event.eventType,
    agentId: event.agentId,
    userId: event.userId,
    toolId: event.toolId,
    status: event.status,
    createdAt: event.createdAt.toISOString(),
    schemaVersion: (event.payload as any)?.schemaVersion ?? 1,
    ...(execution
      ? {
        inputPreview: execution.inputPreview,
        outputPreview: execution.outputPreview,
        inputTruncated: execution.inputTruncated,
        outputTruncated: execution.outputTruncated,
        durationMs: execution.durationMs,
        errorCode: execution.errorCode,
        errorMessage: execution.errorMessage
          ? execution.errorMessage.substring(0, ERROR_CAP_DETAIL)
          : null,
      }
      : {
        // Non‑invocation event: expose raw payload for forensic completeness
        rawPayload: event.payload,
      }),
  };
}