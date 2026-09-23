-- a connection can be marked read-only (nothing is written through it), and
-- labelled with what the database is: production | staging | development
ALTER TABLE "connections" ADD COLUMN "read_only" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "connections" ADD COLUMN "environment" TEXT;
