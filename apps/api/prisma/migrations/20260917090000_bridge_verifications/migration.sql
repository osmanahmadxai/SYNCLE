-- verify / reconcile: is a bridge's destination the copy of its source?
CREATE TABLE "bridge_verifications" (
    "id" TEXT NOT NULL,
    "bridge_id" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "delete_extra" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL,
    "source_rows" INTEGER NOT NULL DEFAULT 0,
    "source_total" INTEGER,
    "result_json" TEXT,
    "error" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "heartbeat_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bridge_verifications_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "bridge_verifications_bridge_id_started_at_idx" ON "bridge_verifications"("bridge_id", "started_at");

ALTER TABLE "bridge_verifications" ADD CONSTRAINT "bridge_verifications_bridge_id_fkey" FOREIGN KEY ("bridge_id") REFERENCES "bridges"("id") ON DELETE CASCADE ON UPDATE CASCADE;
