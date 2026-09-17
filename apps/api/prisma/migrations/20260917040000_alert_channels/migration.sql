-- where Syncle says that a bridge needs someone: a webhook, Slack, e-mail.
-- the configuration is encrypted whole (a Slack webhook URL is its credential)
CREATE TABLE "alert_channels" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "events_json" TEXT NOT NULL,
    "config_enc" TEXT NOT NULL,
    "last_status" TEXT,
    "last_error" TEXT,
    "last_sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "alert_channels_pkey" PRIMARY KEY ("id")
);
