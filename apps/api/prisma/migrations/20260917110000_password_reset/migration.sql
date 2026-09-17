-- a password reset that has been asked for: only the hash of its code is kept
ALTER TABLE "app_users" ADD COLUMN "reset_code_hash" TEXT;
ALTER TABLE "app_users" ADD COLUMN "reset_code_minted_at" TIMESTAMP(3);
ALTER TABLE "app_users" ADD COLUMN "reset_code_expires_at" TIMESTAMP(3);
ALTER TABLE "app_users" ADD COLUMN "reset_code_failures" INTEGER NOT NULL DEFAULT 0;
