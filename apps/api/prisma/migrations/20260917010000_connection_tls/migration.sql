-- TLS settings for a connection, beyond the old on/off "ssl" switch:
--  * "tls_json" — mode (disable / require / verify-ca / verify-full), CA
--    certificate, client certificate, and the server name to verify. Not
--    secret: a certificate is public by design.
--  * "tls_secrets_enc" — the client certificate's private key, encrypted with
--    the master key exactly like a connection password.
--
-- Both are NULL for connections saved before this migration, which keep the
-- behaviour the "ssl" switch always had on their engine.

-- AlterTable
ALTER TABLE "connections" ADD COLUMN "tls_json" TEXT;
ALTER TABLE "connections" ADD COLUMN "tls_secrets_enc" TEXT;
