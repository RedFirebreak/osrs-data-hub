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

On Windows, when Node lives in `C:\Program Files\nodejs`, `corepack enable` needs an elevated shell.
Without one, put the shim in your user npm folder, which the Node installer adds to `PATH`:
`corepack enable --install-directory "$env:APPDATA\npm" pnpm` (PowerShell).

### Environment files

`pnpm dev`, `pnpm dev:worker` and `pnpm db:migrate` load the repo-root `.env` through a preload,
`tools/dev-env.mjs`: neither Next nor tsx reads a `.env` above the package directory. A gitignored
`.env.dev` next to it, if present, overrides `.env` for those scripts only, and variables set in the
shell override both. Use it to keep one `.env` for both the dev scripts and a local
`docker compose up` of the full stack, which reads only `.env` and needs the database host `db`:

```bash
# .env.dev
DATABASE_URL=postgres://hub:hub@127.0.0.1:5432/hub
```

Don't run the full stack and `pnpm dev` at the same time: both listen on port 3000 (`WEB_PORT` moves
the stack's). `pnpm test` and `pnpm test:e2e` don't read either file; they create their own databases
(below).

For Discord login in development, create a Discord application, add the redirect URI
`http://localhost:3000/api/auth/callback/discord`, and fill in `DISCORD_CLIENT_ID`,
`DISCORD_CLIENT_SECRET`, `DISCORD_GUILD_ID` and `AUTH_SECRET` in `.env`.

To pair a RuneLite client with a local hub, install HA Exporter (1.5 or newer, served by the Plugin
Hub since 2026-09-29) and use `http://localhost:3000` as the endpoint URL. Restarting RuneLite updates
an older installed version; the hub refuses anything below `MIN_PLUGIN_VERSION`.

## Commands

| Command | What it does |
|---|---|
| `pnpm test` | All Vitest projects (`core`, `db`, `server`, `worker`, `web`). Needs the dev database. |
| `pnpm vitest run --project core` | One project; `core` needs no database. |
| `pnpm test:e2e` | Playwright end-to-end test of the pairing wizard: builds the web app, starts the standalone server on port 3100, runs Chromium. Needs the dev database. |
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
`postgres://hub:hub@127.0.0.1:5432/postgres`). A run killed before its teardown leaves its template
behind; list them with `psql … -c "select datname from pg_database where datname like 'hub_tpl_%'"` and
drop them (`DROP DATABASE … WITH (FORCE)`) when no run is going.

Plugin behaviour is tested against wire-exact v1.5 payloads in `packages/fixtures` (see its README for
what each file is and which plugin code path produces it). Replace or extend them with captures from a
real client (the Plugin Hub serves 1.5 now; handoff M0).

### End-to-end test (Playwright)

`pnpm test:e2e` (config: `apps/web/playwright.config.ts`, tests: `apps/web/e2e/`) runs the pairing
wizard in Chromium against the real standalone build. `e2e/serve.mjs` builds the app, copies the static
files next to `server.js` as the Dockerfile does, and starts it with a fake Discord preloaded
(`e2e/mock-discord.mjs`: users `alice` and `carol` are members, `bob` is not); the tests fake Discord's
consent page with `page.route()`. The plugin is simulated with Playwright's request API and the payload
fixtures. Each run creates and migrates its own database (`hub_e2e_<random>`) and drops it afterwards.

- Install the browser once with `pnpm --filter @hub/web exec playwright install chromium`, or point
  `PW_CHROMIUM_PATH` at a Chromium binary you already have.
- `E2E_SKIP_BUILD=1` reuses the existing build (CI builds in an earlier step), `E2E_KEEP_DB=1` keeps
  the database for inspection, `E2E_LOG_LEVEL=info` shows the server's logs.
- Playwright starts the web server *before* `globalSetup`, so the server boots against a database that
  doesn't exist yet; `e2e/global-setup.ts` creates it and then waits for the server's live `LISTEN`
  connection to come in, so the first test's live messages aren't lost (TOOL-8).
- Port 3100 must be free: the run always starts its own server, never reuses one.

### Screenshots for visual QA

`E2E_SCREENSHOTS=1 pnpm test:e2e` runs `apps/web/e2e/screenshots.spec.ts` instead of the tests (it is
tagged `@screenshots` and left out of the normal run). It pairs devices, sends the payload fixtures
through `/api/osrs-data/events` (alice owns Zezima and Lynx Titan, whose plugin sends no inventory,
equipment or location; carol owns Iron Mira) and saves every page — login, dashboard (empty and full),
each wizard step, devices, account pages as owner, admin and plain member, guild, settings, privacy,
every admin tab, the API keys page (empty, the create dialog, the key shown once, the list), the
header at 820 and 1024 px, `/docs/api`, menus, dialogs and a toast — at 1440×900 and 390×844 in light and dark to
`apps/web/e2e/screenshots/` (gitignored), named `<nn>-<page>-<viewport>-<scheme>.png`. It takes about
three minutes and asserts nothing about behaviour; look at the images after a UI change. The hub
clamps event times to at most 15 minutes before receipt, so the seeded history spans minutes, not days.

### Running the production builds locally

After `pnpm build`, against a migrated database of your own (`DATABASE_URL=… pnpm --filter @hub/worker
migrate`):

```bash
# worker: reconciles the Timescale policies, creates the pg-boss queues and schedules, runs the jobs
DATABASE_URL=postgres://hub:hub@127.0.0.1:5432/<db> node apps/worker/dist/main.js
# web: the standalone server (copy .next/static and public next to server.js for a working UI,
# as the Dockerfile and e2e/serve.mjs do; API routes work without them)
HOSTNAME=127.0.0.1 PORT=3200 APP_URL=http://127.0.0.1:3200 AUTH_SECRET=<32+ chars> \
  DATABASE_URL=postgres://hub:hub@127.0.0.1:5432/<db> DISCORD_CLIENT_ID=… DISCORD_CLIENT_SECRET=… \
  DISCORD_GUILD_ID=… node apps/web/.next/standalone/apps/web/server.js
```

Without `DISCORD_BOT_TOKEN` the worker says at startup that re-verification is off; without
`METRICS_TOKEN`, `/metrics` answers 404. Both stop cleanly on SIGTERM (the web server exits with 143 by
design).

## Monitoring stack

An opt-in Prometheus and Grafana for looking at the hub's metrics while developing (D-85). They run in
Docker and scrape `pnpm dev` (port 3000) and `pnpm dev:worker` (its metrics on port 9464) on the host
through `host.docker.internal`.

1. Set a token in `.env` or `.env.dev`, e.g. `METRICS_TOKEN=dev-metrics-token`. The dev scripts and the
   Prometheus container read the same files (a value in `.env.dev` wins). Restart `pnpm dev` and
   `pnpm dev:worker` after changing it.
2. Start the stack (it doesn't need the database or the app to be up first):

   ```bash
   docker compose -f compose.monitoring.yaml up -d
   ```

3. Open Grafana at <http://127.0.0.1:3001>; the Hub overview dashboard is the home page (anonymous
   viewer; sign in as `admin`, password `GRAFANA_ADMIN_PASSWORD` or `admin`, to edit). Prometheus is at
   <http://127.0.0.1:9090>; **Status → Targets** should show `hub-web` and `hub-worker` up, and
   **Alerts** the rules from `ops/prometheus/alerts.yml`.

- Prometheus exits at start with "METRICS_TOKEN is empty" when neither file sets it:
  `docker compose -f compose.monitoring.yaml logs prometheus`.
- Prometheus reloads its config and rules after `curl -X POST http://127.0.0.1:9090/-/reload`. Grafana
  re-reads `ops/grafana/dashboards/*.json` within 30 s; its UI can't save over a provisioned dashboard,
  so edit, export as JSON and write the file (OPERATIONS §7).
- Stop it with `docker compose -f compose.monitoring.yaml down` (add `-v` to drop the stored series).
- Without `METRICS_TOKEN` both endpoints answer 404, and `WORKER_METRICS_PORT=0` turns the worker's off
  (for a second worker on the same machine). A worker whose port is taken logs `metrics endpoint failed`
  and keeps running its jobs.
- Check an endpoint by hand: `curl -H "Authorization: Bearer dev-metrics-token" http://localhost:9464/metrics`.

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
- Document decisions in `docs/ARCHITECTURE.md` (decision log). There is no changelog file: what changed
  is the git history (commit messages and pull requests).

## CI

`.github/workflows/ci.yml` runs on every pull request and on `main`:

| Job | Checks |
|---|---|
| Lint & typecheck | gotcha registry, Prettier, `tsc`, ESLint, migrations in sync with the schema |
| Tests | Vitest against a `timescale/timescaledb:2.30.1-pg18` service container |
| Build | `next build` and the worker bundle |
| Docker images | both image targets build |
| E2E (wizard) | `next build`, then the Playwright wizard test (`pnpm test:e2e`) against a TimescaleDB service container; uploads the Playwright report and traces when it fails |

`main` is protected: make these jobs required checks in the branch protection rule.
