-- AlterTable
ALTER TABLE "audit_events" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "tool_executions" ALTER COLUMN "started_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "completed_at" SET DATA TYPE TIMESTAMPTZ(3);
