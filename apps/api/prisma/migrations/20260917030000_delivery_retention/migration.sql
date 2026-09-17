-- Delivery details are now removed after a retention period. The job keeps its
-- counters; these two columns record what has been removed, so the timeline can
-- tell "delivered, details removed" from "not delivered yet".
ALTER TABLE "bridge_jobs" ADD COLUMN "pruned_deliveries" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "bridge_jobs" ADD COLUMN "pruned_below_sequence" INTEGER;
