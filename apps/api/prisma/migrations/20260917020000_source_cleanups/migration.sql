-- things a bridge left on a source database that still have to be removed
-- (a replication slot that could not be dropped when its bridge was deleted)
CREATE TABLE "source_cleanups" (
    "id" TEXT NOT NULL,
    "bridge_id" TEXT NOT NULL,
    "bridge_name" TEXT,
    "connection_id" TEXT NOT NULL,
    "database" TEXT,
    "engine" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "source_cleanups_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "source_cleanups_bridge_id_connection_id_key" ON "source_cleanups"("bridge_id", "connection_id");
CREATE INDEX "source_cleanups_connection_id_idx" ON "source_cleanups"("connection_id");
