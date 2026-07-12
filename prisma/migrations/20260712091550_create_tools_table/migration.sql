-- CreateTable
CREATE TABLE "tools" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT,
    "handler_type" TEXT NOT NULL,
    "handler_config" TEXT NOT NULL,
    "input_schema" JSONB NOT NULL,
    "output_schema" JSONB,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tools_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tools_tenant_id_idx" ON "tools"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "tools_tenant_id_name_key" ON "tools"("tenant_id", "name");

-- AddForeignKey
ALTER TABLE "tools" ADD CONSTRAINT "tools_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
