# Development

## Prerequisites

- Node **24** (`.nvmrc`; 22.12+ works) with corepack, so `pnpm` resolves to the version pinned in
  `package.json` (`packageManager`).
- Docker, for the Postgres + TimescaleDB database.
- Python 3, for the gotcha registry check.

## First run

```bash
corepack enable
pnpm install
docker compose -f compose.dev.yaml up -d      # TimescaleDB 2.30.1 on Postgres 18 at 127.0.0.1:5432
cp .env.example .env                          # then set DATABASE_URL=postgres://hub:hub@127.0.0.1:5432/hub
pnpm db:migrate                               # apply migrations to the dev database
pnpm dev                                      # web on http://localhost:3000
pnpm dev:worker                               # scheduled jobs (optional in dev)
```

For Discord login in development, create a Discord application, add the redirect URI
`http://localhost:3000/api/auth/callback/discord`, and fill in `DISCORD_CLIENT_ID`,
`DISCORD_CLIENT_SECRET`, `DISCORD_GUILD_ID` and `AUTH_SECRET` in `.env`.

To pair a RuneLite client with a local hub, run the HA Exporter plugin (≥ 1.5) side-loaded from its
repository (`./gradlew run`) and use `http://localhost:3000` as the endpoint URL. The Plugin Hub listing
still serves v1.4, which the hub refuses.

## Commands

| Command | What it does |
|---|---|
| `pnpm test` | All Vitest projects (`core`, `db`, `server`, `worker`, `web`). Needs the dev database. |
| `pnpm vitest run --project core` | One project; `core` needs no database. |
| `pnpm typecheck` | `tsc` in every package (`next typegen && tsc` for the web app). |
| `pnpm lint` | ESLint 10 flat config at the root, type-aware rules. Run `pnpm typecheck` first on a fresh checkout. |
| `pnpm format` / `pnpm format:check` | Prettier. |
| `pnpm build` | `next build` (standalone) and the bundled worker. |
| `pnpm db:generate` | Generate a migration after changing `packages/db/src/schema/`. |
| `pnpm db:check` | Check the migration journal for consistency. |
| `pnpm db:migrate` | Apply migrations to `DATABASE_URL`. |
| `pnpm gotchas` | Validate `docs/gotchas/` (must print `OK`). |

## Tests and the database

Tests that touch the database use one server and isolate by **database**: a Vitest `globalSetup`
migrates a template database of its own once per run (so concurrent runs never collide), and each test file clones it (`createTestDatabase()` from
`@hub/db/testing`, about 30 ms) and drops it afterwards. The template is locked against connections,
because TimescaleDB's scheduler otherwise races the clone (TSDB-4). Point `TEST_DATABASE_URL` at an admin
connection if your server isn't the dev compose one (default
`postgres://hub:hub@127.0.0.1:5432/postgres`).

Plugin behaviour is tested against wire-exact v1.5 payloads in `packages/fixtures` (see its README for
what each file is and which plugin code path produces it). Replace or extend them with captures from a
side-loaded plugin when available (handoff M0).

## Changing the schema

1. Edit `packages/db/src/schema/*`.
2. `pnpm db:generate` and review the SQL. Timescale objects (hypertables, continuous aggregates) go in a
   custom migration: `pnpm --filter @hub/db exec drizzle-kit generate --custom --name=<name>`.
3. Remember that `migrate()` runs all pending migrations in one transaction (DB-7), applies only
   migrations newer than the last applied one (DB-8), and that `drizzle-kit push`/`pull` are banned
   (DB-6). Policies are not created in migrations; the worker reconciles them (D-40).
4. If you changed a Better Auth table, keep `apps/web/src/lib/auth.ts` `additionalFields` in step, or
   every auth request fails (AUTH-1).

CI fails when the schema and the committed migrations disagree.

## Conventions

- ESM everywhere, **extensionless** relative imports (NEXT-10), strict TypeScript (6.0.3, TOOL-1).
- `packages/core` is pure: no I/O. Database access lives in `packages/db` (schema, helpers) and
  `packages/server` (services). Route handlers in `apps/web` stay thin.
- Process-wide singletons go on `globalThis` (NEXT-3).
- Never log tokens, request bodies, coordinates, or database error messages (DB-3); log codes and counts.
- Cite gotchas by ID in comments when code works around one (`// See PLUGIN-2: …`), and record new ones
  with the `gotcha` skill.
- Document decisions in `docs/ARCHITECTURE.md` (decision log) and changes in `docs/CHANGELOG.md`.

## CI

`.github/workflows/ci.yml` runs on every pull request and on `main`:

| Job | Checks |
|---|---|
| Lint & typecheck | gotcha registry, Prettier, `tsc`, ESLint, migrations in sync with the schema |
| Tests | Vitest against a `timescale/timescaledb:2.30.1-pg18` service container |
| Build | `next build` and the worker bundle |
| Docker images | both image targets build |

`main` is protected: make these jobs required checks in the branch protection rule.
