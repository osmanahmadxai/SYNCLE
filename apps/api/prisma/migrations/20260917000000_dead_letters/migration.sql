-- Dead-letter queue for live bridges (CDC / watch) running `onError: continue`.
--
-- A change stream cannot be re-read once the source has been acknowledged past
-- a position. Until now a failed batch was recorded only in
-- "bridge_deliveries"."request_body" — capped for display, and refused by the
-- resend path once cut — and the cursor then moved on, so the rows were gone.
--
-- "rows_json" holds the COMPLETE source row(s), written before the cursor
-- advances. Bad rows are isolated from their batch first, so an entry is
-- normally a single row.

-- CreateTable
CREATE TABLE "bridge_dead_letters" (
    "id" TEXT NOT NULL,
    "bridge_id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "op" TEXT,
    "rows_json" TEXT NOT NULL,
    "row_count" INTEGER NOT NULL,
    "cursor" TEXT,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "succeeded_targets_json" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "bridge_dead_letters_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "bridge_dead_letters_bridge_id_status_idx" ON "bridge_dead_letters"("bridge_id", "status");

-- CreateIndex
CREATE INDEX "bridge_dead_letters_job_id_idx" ON "bridge_dead_letters"("job_id");

-- AddForeignKey
ALTER TABLE "bridge_dead_letters" ADD CONSTRAINT "bridge_dead_letters_bridge_id_fkey" FOREIGN KEY ("bridge_id") REFERENCES "bridges"("id") ON DELETE CASCADE ON UPDATE CASCADE;
