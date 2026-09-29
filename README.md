# osrs-data-hub

A self-hostable web app for one Discord guild (clan) that collects Old School RuneScape account data from
the **HA Exporter** RuneLite plugin (v1.5+), keeps long-term history per account, and shares it inside
the guild.

- **Receives** data from the plugin: a drop-in endpoint for its pairing and ingest protocol (the same
  one the ha-osrs-data Home Assistant integration speaks).
- **Aggregates** per OSRS account: current state, 10+ years of XP history, events (loot, levels,
  deaths, collection log, diaries, combat tasks), play sessions, gear, wealth and a location trail.
- **Shows** it: a personal dashboard, account pages, a guild page, and live event toasts.
- **Shares** it: per-account, per-category permissions, and (Milestone 3) a pull-only REST API with
  scoped keys for Home Assistant, a Discord bot or a live map.

Login is Discord OAuth, gated on membership of the configured guild (and optionally a role).

## How players get connected

1. Install **HA Exporter** (1.5 or newer) from the RuneLite Plugin Hub.
2. Sign in to the hub with Discord and open **Add device**: it shows a 5-digit code and the hub URL.
3. Paste both into the plugin panel and press Submit. The wizard confirms the connection live.
4. Log in to OSRS: "Receiving data for *Zezima*".

What the plugin sends is decided in the plugin's own settings; the hub stores only what arrives.

## Stack

TypeScript monorepo (pnpm): Next.js 16 (App Router, Node runtime), Better Auth (Discord), Drizzle ORM,
PostgreSQL 18 + TimescaleDB (hypertables, compression, retention, continuous aggregates), pg-boss,
Tailwind + shadcn/ui, Vitest. Docker Compose on one VM.

```
apps/web            Next.js: UI, plugin endpoints, live stream (SSE)
apps/worker         scheduled jobs (pg-boss) + migrations entrypoint
packages/core       pure logic: payload parsing, event normalization, permissions, time rules
packages/db         schema, migrations (incl. TimescaleDB), test database helpers
packages/server     services: ingest, pairing, devices, accounts, sharing, live fan-out, offboarding
packages/fixtures   wire-exact HA Exporter v1.5 payloads for tests
```

## Documentation

| | |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | How it works, and the decision log |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Self-hosting: configuration, reverse proxy, backups, retention |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | Local setup, tests, CI |
| [docs/CHANGELOG.md](docs/CHANGELOG.md) | Changes per pull request |
| [docs/gotchas/](docs/gotchas/README.md) | Known traps in the shared layer, indexed by symptom |

## Quick start (development)

```bash
corepack enable && pnpm install
docker compose -f compose.dev.yaml up -d
cp .env.example .env   # set DATABASE_URL=postgres://hub:hub@127.0.0.1:5432/hub and the Discord values
pnpm db:migrate && pnpm dev
```

## Status

V1 is being built milestone by milestone (see [docs/ARCHITECTURE.md §14](docs/ARCHITECTURE.md#14-milestones-and-status)).
