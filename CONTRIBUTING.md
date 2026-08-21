# Contributing to Syncle

Thanks for taking the time to contribute! This guide covers everything you need
to get a change merged.

## Getting set up

Syncle is a pnpm monorepo (`web → api → core`). You'll need:

- **Node.js ≥ 22** (the MySQL binlog reader requires it)
- **pnpm ≥ 10**
- **Docker** (for the bundled Postgres + Redis)

```bash
git clone https://github.com/osmanahmadxai/SYNCLE.git
cd SYNCLE
pnpm install
docker compose up -d          # postgres (metadata) + redis (queue)
pnpm dev                      # API + web in watch mode
```

The web app comes up on `http://localhost:3002`, the API on
`http://localhost:4002/api`.

## Project layout

```
packages/core   @syncle/core — pure domain logic, adapters, schemas (no framework)
apps/api        @syncle/api  — NestJS backend, Prisma, BullMQ, CDC providers
apps/web        @syncle/web  — Next.js frontend
```

The dependency direction is one-way: `core` never imports from `api`/`web`, and
`api` never imports from `web`. Keep it that way.

## Before you open a PR

Run the full quality gate locally — CI runs the same thing:

```bash
pnpm typecheck     # all workspaces
pnpm test          # unit tests
pnpm build         # core → api → web
```

If you change `packages/core`, rebuild it (`pnpm build:core`) before the API
will pick up the new types — `core` is consumed from its compiled `dist/`.

Testing an HTTP destination by hand? `pnpm dev:receiver` starts a tiny echo
server on `http://localhost:4990` that logs every request it receives.

## Pull requests

- Branch off `main` with a descriptive name (`feature/…`, `fix/…`).
- Keep each PR focused on one thing. Smaller is easier to review.
- Update docs/README when behaviour changes.
- Make sure `pnpm typecheck`, `pnpm test`, and `pnpm build` all pass.
- Fill out the PR template.

## Adding a database engine

Implement the `DatabaseAdapter` interface in
`packages/core/src/adapters/` and register it in the registry. The connection
form, schema browser, and feature gating are all derived from that one
registration — no UI wiring needed.

For event-based delivery on a new engine, add a `CdcProvider` under
`apps/api/src/hooks/cdc/providers/` and register it in `hooks.module.ts`.

## Commit style

Short, imperative subject lines ("Add MySQL binlog CDC", not "added…"). Explain
the *why* in the body when it isn't obvious.

## Reporting bugs / requesting features

Use the issue templates. The more reproduction detail you give, the faster it
gets fixed.
