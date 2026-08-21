# syntax=docker/dockerfile:1
#
# Single image that runs both the API and the web GUI — docker-compose.app.yml
# starts two containers from it with different commands. See `bin/syncle`.
#
# Two stages: `build` compiles the monorepo with the full toolchain, `runtime`
# ships only production artifacts — the API's pruned prod install (via
# `pnpm deploy`) and the web app's Next standalone output. No compilers, no
# git, no dev dependencies, and it runs as the unprivileged `node` user.

FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
WORKDIR /app

# Toolchain: build-essential + python3 for better-sqlite3's native addon,
# openssl for Prisma's query engine, git for any git: dependencies.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ openssl ca-certificates git \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable \
 && corepack prepare pnpm@10.33.0 --activate

# 1) Install deps from just the manifests so this layer caches across code edits.
#    apps/api/prisma is copied first because @syncle/api's postinstall runs
#    `prisma generate`, which needs the schema.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/core/package.json packages/core/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/api/prisma apps/api/prisma
RUN pnpm install --frozen-lockfile

# 2) Build everything.
#    NEXT_PUBLIC_API_URL is deliberately NOT set: anything NEXT_PUBLIC_* is
#    inlined into the browser bundle at build time, so baking an API address
#    here would pin this published image to one host. Instead the browser calls
#    a relative /api and the web server proxies it (see the web app's
#    app/api/[...path]/route.ts), with the target read at runtime from
#    SYNCLE_API_ORIGIN. One image, works on localhost, a LAN box or behind a
#    reverse proxy.
#    NEXT_OUTPUT=standalone makes `next build` emit the self-contained server
#    used by the runtime stage (plain `next start` keeps working outside Docker).
COPY . .
ENV NEXT_OUTPUT=standalone
RUN pnpm --filter @syncle/core build \
 && pnpm --filter @syncle/api build \
 && pnpm --filter @syncle/web build

# 3) Prune the API to production dependencies only (dist + prisma + prod
#    node_modules, including the prisma CLI for `migrate deploy` at boot).
# --legacy: copy workspace deps into node_modules rather than requiring the
# repo-wide inject-workspace-packages setting (pnpm v10 default changed)
#
# `prisma generate` has to run AGAIN inside the pruned tree. The client that
# `prisma generate` produces lives in node_modules/.prisma/client, which
# belongs to no package in the store — so `pnpm deploy`, which copies packages
# from the store, leaves it behind. Without this the image starts, applies its
# migrations, and only then dies on MODULE_NOT_FOUND for .prisma/client.
RUN pnpm --filter @syncle/api deploy --prod --legacy /out/api \
 && cd /out/api \
 && ./node_modules/.bin/prisma generate \
 && node -e "require('@prisma/client')"

# ---------------------------------------------------------------------------

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# openssl for Prisma's engines; nothing else from the build toolchain.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# API: pruned production install.
COPY --from=build /out/api /app/apps/api
# Web: Next standalone server (nested under apps/web because the monorepo root
# is the file-tracing root) plus its static assets.
COPY --from=build /app/apps/web/.next/standalone /app/web
COPY --from=build /app/apps/web/.next/static /app/web/apps/web/.next/static
COPY --from=build /app/apps/web/public /app/web/apps/web/public

# The api data dir must exist before the named volume mounts over it, and the
# whole tree must be writable by the unprivileged user.
RUN mkdir -p /app/apps/api/.syncle && chown -R node:node /app
USER node

# API 4002, Web 3002 — the actual command per container comes from compose.
EXPOSE 4002 3002
