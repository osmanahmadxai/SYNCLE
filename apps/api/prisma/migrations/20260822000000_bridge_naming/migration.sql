-- Rename the domain: a "hook" is now a bridge, a "run" is now a job.
--   hooks           -> bridges
--   hook_runs       -> bridge_jobs        (hook_id -> bridge_id)
--   hook_deliveries -> bridge_deliveries  (run_id  -> job_id)
-- Pure in-place renames (tables, columns, constraints, indexes) so all
-- existing data survives. Constraint/index names are renamed to the defaults
-- Prisma derives from the new model names, keeping schema and database in sync.

-- Tables
ALTER TABLE "hooks" RENAME TO "bridges";
ALTER TABLE "hook_runs" RENAME TO "bridge_jobs";
ALTER TABLE "hook_deliveries" RENAME TO "bridge_deliveries";

-- Columns
ALTER TABLE "bridge_jobs" RENAME COLUMN "hook_id" TO "bridge_id";
ALTER TABLE "bridge_deliveries" RENAME COLUMN "run_id" TO "job_id";

-- Constraints (renaming a PK constraint renames its backing index with it)
ALTER TABLE "bridges" RENAME CONSTRAINT "hooks_pkey" TO "bridges_pkey";
ALTER TABLE "bridges" RENAME CONSTRAINT "hooks_workspace_id_fkey" TO "bridges_workspace_id_fkey";
ALTER TABLE "bridge_jobs" RENAME CONSTRAINT "hook_runs_pkey" TO "bridge_jobs_pkey";
ALTER TABLE "bridge_jobs" RENAME CONSTRAINT "hook_runs_hook_id_fkey" TO "bridge_jobs_bridge_id_fkey";
ALTER TABLE "bridge_deliveries" RENAME CONSTRAINT "hook_deliveries_pkey" TO "bridge_deliveries_pkey";
ALTER TABLE "bridge_deliveries" RENAME CONSTRAINT "hook_deliveries_run_id_fkey" TO "bridge_deliveries_job_id_fkey";

-- Indexes
ALTER INDEX "hooks_connection_id_idx" RENAME TO "bridges_connection_id_idx";
ALTER INDEX "hooks_workspace_id_idx" RENAME TO "bridges_workspace_id_idx";
ALTER INDEX "hook_runs_hook_id_idx" RENAME TO "bridge_jobs_bridge_id_idx";
ALTER INDEX "hook_runs_status_idx" RENAME TO "bridge_jobs_status_idx";
ALTER INDEX "hook_deliveries_run_id_idx" RENAME TO "bridge_deliveries_job_id_idx";
ALTER INDEX "hook_deliveries_run_id_sequence_key" RENAME TO "bridge_deliveries_job_id_sequence_key";
