-- bridges that read a PostgreSQL source through one shared replication slot,
-- and how far each of them has got: the slot is confirmed up to the slowest
CREATE TABLE "cdc_shared_members" (
    "bridge_id" TEXT NOT NULL,
    "slot_key" TEXT NOT NULL,
    "schema_name" TEXT NOT NULL,
    "table_name" TEXT NOT NULL,
    "ops" TEXT NOT NULL,
    "confirmed_lsn" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cdc_shared_members_pkey" PRIMARY KEY ("bridge_id")
);

CREATE INDEX "cdc_shared_members_slot_key_idx" ON "cdc_shared_members"("slot_key");
