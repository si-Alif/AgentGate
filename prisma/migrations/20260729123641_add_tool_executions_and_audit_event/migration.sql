-- CreateTable
CREATE TABLE "tool_executions" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "tool_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "input_preview" JSONB,
    "output_preview" JSONB,
    "input_truncated" BOOLEAN NOT NULL DEFAULT false,
    "output_truncated" BOOLEAN NOT NULL DEFAULT false,
    "error_code" TEXT,
    "error_message" TEXT,
    "duration_ms" INTEGER NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tool_executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "agent_id" TEXT,
    "user_id" TEXT,
    "tool_id" TEXT,
    "event_type" TEXT NOT NULL,
    "status" TEXT,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tool_executions_tenant_id_agent_id_idx" ON "tool_executions"("tenant_id", "agent_id");

-- CreateIndex
CREATE INDEX "tool_executions_tenant_id_tool_id_idx" ON "tool_executions"("tenant_id", "tool_id");

-- CreateIndex
CREATE INDEX "tool_executions_tenant_id_created_at_idx" ON "tool_executions"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_events_tenant_id_created_at_id_idx" ON "audit_events"("tenant_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "audit_events_tenant_id_agent_id_idx" ON "audit_events"("tenant_id", "agent_id");

-- CreateIndex
CREATE INDEX "audit_events_tenant_id_tool_id_idx" ON "audit_events"("tenant_id", "tool_id");

-- CreateIndex
CREATE INDEX "audit_events_tenant_id_event_type_idx" ON "audit_events"("tenant_id", "event_type");

-- AddForeignKey
ALTER TABLE "tool_executions" ADD CONSTRAINT "tool_executions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
