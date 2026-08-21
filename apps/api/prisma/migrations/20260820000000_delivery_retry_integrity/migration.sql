-- Retry integrity for hook deliveries:
--  * "op" — the CDC operation behind the delivery, so a resend replays a
--    delete as a keyed delete instead of resurrecting the deleted row.
--  * "body_truncated" — the captured request body was cut at the storage cap
--    and can no longer be replayed faithfully; resends refuse such deliveries.
--  * "succeeded_targets_json" — database-sink fan-out: target keys that have
--    already committed, so a retry skips them instead of double-writing.

-- AlterTable
ALTER TABLE "hook_deliveries" ADD COLUMN "op" TEXT;
ALTER TABLE "hook_deliveries" ADD COLUMN "body_truncated" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "hook_deliveries" ADD COLUMN "succeeded_targets_json" TEXT;
