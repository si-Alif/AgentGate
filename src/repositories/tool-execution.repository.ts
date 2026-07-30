import { auditPrisma } from "../lib/audit-prisma.js";
import type { DbClient } from "../types/db-client.type.js";
import type { Prisma } from "@prisma/client";

export interface CreateToolExecutionInput {
  id: string;
  tenantId: string;
  agentId: string;
  toolId: string;
  status: string;
  durationMs: number;
  startedAt: Date;
  completedAt: Date;
  inputTruncated: boolean;
  outputTruncated: boolean;
  inputPreview?: unknown;
  outputPreview?: unknown;
  errorCode?: string | undefined;
  errorMessage?: string | undefined;
}

export const toolExecutionRepository = {
  // Default client is auditPrisma (the DEDICATED pool) since the
  // worker — this repo's only writer — is the sole caller in the
  // common case. A transaction client (tx) is always passed explicitly
  // from inside auditPrisma.$transaction(), same explicit-unit-of-work
  // pattern as every other repository in this codebase.
  create: (data: CreateToolExecutionInput, client: DbClient = auditPrisma) => {
    // 1. Initialize required properties
    const createData: Prisma.ToolExecutionUncheckedCreateInput = {
      id: data.id,
      tenantId: data.tenantId,
      agentId: data.agentId,
      toolId: data.toolId,
      status: data.status,
      durationMs: data.durationMs,
      startedAt: data.startedAt,
      completedAt: data.completedAt,
      inputTruncated: data.inputTruncated,
      outputTruncated: data.outputTruncated,
    };

    // 2. Conditionally attach optional properties ONLY when defined
    if (data.inputPreview !== undefined) {
      createData.inputPreview = data.inputPreview as Prisma.InputJsonValue;
    }
    if (data.outputPreview !== undefined) {
      createData.outputPreview = data.outputPreview as Prisma.InputJsonValue;
    }
    if (data.errorCode !== undefined) {
      createData.errorCode = data.errorCode;
    }
    if (data.errorMessage !== undefined) {
      createData.errorMessage = data.errorMessage;
    }

    // 3. Pass cleanly formed object to Prisma
    return client.toolExecution.create({
      data: createData,
    });
  },

  findByIds: (ids: string[], tenantId: string, client: DbClient = auditPrisma) =>
    client.toolExecution.findMany({ where: { id: { in: ids }, tenantId } }),
};