-- CreateTable
CREATE TABLE "agent_tool_permissions" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "tool_id" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "parameter_constraints" JSONB,
    "call_budget_per_hour" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_tool_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_tool_permissions_tenant_id_idx" ON "agent_tool_permissions"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_tool_permissions_agent_id_tool_id_key" ON "agent_tool_permissions"("agent_id", "tool_id");

-- AddForeignKey
ALTER TABLE "agent_tool_permissions" ADD CONSTRAINT "agent_tool_permissions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_tool_permissions" ADD CONSTRAINT "agent_tool_permissions_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_tool_permissions" ADD CONSTRAINT "agent_tool_permissions_tool_id_fkey" FOREIGN KEY ("tool_id") REFERENCES "tools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
