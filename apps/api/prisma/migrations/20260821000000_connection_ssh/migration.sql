-- SSH tunnel config on connections: non-secret fields as JSON (secrets
-- blanked out), secret material encrypted separately, mirroring hooks'
-- destination_json / auth_enc split.
ALTER TABLE "connections" ADD COLUMN "ssh_json" TEXT;
ALTER TABLE "connections" ADD COLUMN "ssh_secrets_enc" TEXT;
