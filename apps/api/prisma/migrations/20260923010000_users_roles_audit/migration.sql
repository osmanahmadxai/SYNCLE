-- accounts have a role; one can be disabled; when it last signed in
ALTER TABLE "app_users" ADD COLUMN "role" TEXT NOT NULL DEFAULT 'admin';
ALTER TABLE "app_users" ADD COLUMN "disabled_at" TIMESTAMP(3);
ALTER TABLE "app_users" ADD COLUMN "last_login_at" TIMESTAMP(3);

-- who did what
CREATE TABLE "audit_entries" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_type" TEXT NOT NULL,
    "actor_id" TEXT,
    "actor_name" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target_type" TEXT,
    "target_id" TEXT,
    "target_name" TEXT,
    "details_json" TEXT,
    "ip" TEXT,

    CONSTRAINT "audit_entries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "audit_entries_at_idx" ON "audit_entries"("at");
CREATE INDEX "audit_entries_action_at_idx" ON "audit_entries"("action", "at");
CREATE INDEX "audit_entries_target_id_at_idx" ON "audit_entries"("target_id", "at");
CREATE INDEX "audit_entries_actor_id_at_idx" ON "audit_entries"("actor_id", "at");
