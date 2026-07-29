import { auditPrisma } from "../lib/audit-prisma.js";
import type { DbClient } from "../types/db-client.type.js";

export interface CreateAuditEventInput {
  id: string;
  tenantId: string;
  agentId: string | null;
  userId: string | null;
  toolId: string | null;
  eventType: string;
  status: string | null;
  payload: unknown;
}

export const auditEventRepository = {
  create: (data: CreateAuditEventInput, client: DbClient = auditPrisma) =>
    client.auditEvent.create({
      data: {
        id: data.id,
        tenantId: data.tenantId,
        agentId: data.agentId,
        userId: data.userId,
        toolId: data.toolId,
        eventType: data.eventType,
        status: data.status,
        payload: data.payload as any,
      },
    }),
};