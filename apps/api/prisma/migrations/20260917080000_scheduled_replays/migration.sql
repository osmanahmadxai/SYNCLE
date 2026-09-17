-- a replay bridge can run by itself, on a cron line. what became of its last
-- tick is kept with the bridge, and a run remembers who started it
ALTER TABLE "bridges" ADD COLUMN "schedule_state_json" TEXT;
ALTER TABLE "bridge_jobs" ADD COLUMN "started_by" TEXT NOT NULL DEFAULT 'manual';
