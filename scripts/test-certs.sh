#!/bin/sh
# Generates the throwaway PKI the TLS integration tests run against. Runs inside
# the `certs` service of docker-compose.test.yml; everything lands in /certs,
# which is .test-certs/ on the host (git-ignored — these keys protect nothing).
#
#   ca.crt / ca.key           the CA the TLS servers' certificate chains to
#   server.crt / server.key   issued to localhost + 127.0.0.1 (what tests dial)
#   server.pem                certificate + key in one file (MongoDB wants that)
#   client.crt / client.key   a client certificate, for the mutual-TLS server
#   other-ca.crt              an unrelated CA: trusting it must NOT be enough
#
# Idempotent: an existing, unexpired set is left alone, so the servers and the
# tests agree across `docker compose up` runs.
set -eu
cd /certs

if [ -f ca.crt ] && [ -f server.crt ] && [ -f client.crt ] && [ -f other-ca.crt ] \
   && openssl x509 -checkend 86400 -noout -in server.crt >/dev/null 2>&1; then
  echo "test certificates already present"
  exit 0
fi

rm -f ./*.crt ./*.key ./*.pem ./*.csr ./*.srl ./*.cnf

openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -subj "/CN=Syncle Test CA" -keyout ca.key -out ca.crt >/dev/null 2>&1

cat > server.cnf <<CNF
subjectAltName = DNS:localhost, IP:127.0.0.1
extendedKeyUsage = serverAuth
CNF
openssl req -newkey rsa:2048 -nodes -subj "/CN=localhost" \
  -keyout server.key -out server.csr >/dev/null 2>&1
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -days 3650 -extfile server.cnf -out server.crt >/dev/null 2>&1
cat server.crt server.key > server.pem

cat > client.cnf <<CNF
extendedKeyUsage = clientAuth
CNF
openssl req -newkey rsa:2048 -nodes -subj "/CN=syncle-test-client" \
  -keyout client.key -out client.csr >/dev/null 2>&1
openssl x509 -req -in client.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -days 3650 -extfile client.cnf -out client.crt >/dev/null 2>&1

openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -subj "/CN=Some Other CA" -keyout other-ca.key -out other-ca.crt >/dev/null 2>&1

rm -f ./*.csr ./*.srl ./*.cnf other-ca.key
# the database images run as different users; these are test keys, so readable
chmod 644 ./*.crt ./*.key ./*.pem
echo "test certificates generated"
