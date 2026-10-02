# syntax=docker/dockerfile:1
# One Dockerfile, two targets:
#   docker build --target web    -t osrs-data-hub-web .
#   docker build --target worker -t osrs-data-hub-worker .
# node:24-alpine: corepack ships with Node 24 but not with Node >= 25 (TOOL-6).

FROM node:24-alpine AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo

# ---- deps: lockfile only, so the store fetch is cached until the lockfile changes
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm fetch

# ---- source: full tree + offline install from the fetched store
FROM deps AS source
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile --offline

FROM source AS build-web
RUN pnpm --filter @hub/web build

FROM source AS build-worker
RUN pnpm --filter @hub/worker build

# ---- web runtime: Next standalone output (server.js sits at apps/web/server.js in a monorepo)
FROM node:24-alpine AS web
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    # Without this, server.js binds to the container hostname and localhost healthchecks fail (NEXT-9).
    HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build-web --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build-web --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build-web --chown=node:node /repo/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/api/health" >/dev/null || exit 1
CMD ["node", "apps/web/server.js"]

# ---- worker runtime: bundled ESM files (main.js, migrate.js) + the SQL migrations, no node_modules
FROM node:24-alpine AS worker
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build-worker --chown=node:node /repo/apps/worker/dist ./dist
# The drizzle migrator reads the journal and SQL files from disk at runtime.
COPY --from=build-worker --chown=node:node /repo/packages/db/drizzle ./dist/drizzle
USER node
CMD ["node", "--enable-source-maps", "dist/main.js"]
