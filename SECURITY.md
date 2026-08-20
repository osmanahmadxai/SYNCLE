# Security Policy

## Supported versions

Syncle is pre-1.0 and moves fast; security fixes land on `main` and the
latest release only.

| Version | Supported |
| ------- | --------- |
| latest  | ✅        |
| older   | ❌        |

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Email **osmanahmadxai@gmail.com** with:

- a description of the issue and its impact,
- steps to reproduce (a proof of concept helps), and
- any suggested fix you have in mind.

You'll get an acknowledgement within a few days. Once a fix is ready I'll
coordinate disclosure timing with you and credit you in the release notes unless
you'd rather stay anonymous.

## Security model

Syncle is built to run on a trusted network, but it does ship its own
protections:

- **Single-operator auth on every route.** First run creates the one admin
  account (guarded by a one-time setup token printed to the server console),
  after which a scrypt-hashed password and a signed httpOnly session cookie
  protect the whole API. Password changes invalidate all outstanding sessions,
  and the login/setup endpoints rate-limit repeated failures.
- **Secrets encrypted at rest.** Connection credentials and hook auth secrets
  are AES-256-GCM encrypted under `SYNCLE_MASTER_KEY` (session cookies are
  signed with an HKDF-derived sub-key, so encryption and signing stay
  independent). Set the key explicitly in production.
- **Outbound destination guard.** Hook deliveries never follow redirects and
  always refuse cloud metadata endpoints (169.254.169.254 and friends). On a
  network-exposed deployment, set `SYNCLE_BLOCK_PRIVATE_DESTINATIONS=true` to
  also refuse loopback/private/link-local destinations — it is off by default
  because posting to localhost services is a primary local use case.
- **SQLite path jail.** Set `SYNCLE_SQLITE_DIR` to restrict which files SQLite
  connections may open/create on the server.

Still your job when exposing Syncle beyond localhost: TLS termination,
completing first-run setup before the port is reachable, and network-level
control over who can reach the API at all.

Things that are always in scope and that I care about: credential handling,
SQL/command injection through the adapters, payload-template injection, auth
bypasses, and SSRF that dodges the destination guard.
