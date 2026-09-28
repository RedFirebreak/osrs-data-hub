# Toolchain and libraries

Build, lint and package tooling (TypeScript, ESLint, pnpm, tsup, shadcn, Docker base images) and the pg-boss and zod libraries.

| ID | Symptom |
|---|---|
| [PGBOSS-1](#pgboss-1) | pg-boss throws `Queue <name> does not exist` (or `not found`) on send or schedule, a worker never runs while `error` events repeat every poll, or a handler finds `job.data` undefined. |
| [TOOL-1](#tool-1) | After `pnpm add -D typescript`, typescript-eslint or Next's type check breaks; or `tsc` fails with `TS2591 Cannot find name 'node:crypto'`, `TS5101` (baseUrl) or `TS5107` (moduleResolution node). |
| [TOOL-2](#tool-2) | `shadcn init` in a script exits 0 having created nothing, or `next build` fails offline with `next/font: error … fonts.googleapis.com`. |
| [TOOL-3](#tool-3) | ESLint crashes with `TypeError: Error while loading rule 'react/display-name': contextOrFilename.getFilename is not a function`. |
| [TOOL-4](#tool-4) | The tsup-bundled worker crashes at start with `Error: Dynamic require of "events" is not supported`, or with `ReferenceError: __dirname is not defined in ES module scope` from pino. |
| [TOOL-5](#tool-5) | `node_modules/.pnpm` holds several `drizzle-orm@0.45.3_<peers>` directories, and workspace packages resolve different ones. |
| [TOOL-6](#tool-6) | A Docker build on `node:26-alpine` fails with `sh: corepack: not found`. |
| [TOOL-7](#tool-7) | After `pnpm format`, `tools/check_gotchas.py` reports `has no '*Source: ...*' line` for every entry, and doc tables are re-padded. |
| [ZOD-1](#zod-1) | Unknown or new fields in a plugin payload vanish after parsing: stored event data lacks keys the plugin sent. |

### PGBOSS-1
**pg-boss throws `Queue <name> does not exist` (or `not found`) on send or schedule, a worker never runs while `error` events repeat every poll, or a handler finds `job.data` undefined.**
In pg-boss 12 queues must be created first: `send` throws `Queue x does not exist` (manager.js:853) and
`schedule` `Queue x not found` (timekeeper.js:845), while `work()` on a missing queue doesn't throw: it
returns a worker id and emits `error` on every poll. Handlers always receive an array of jobs
(`WorkHandler = (jobs: Job[]) => …`, types.d.ts:899), even with batch size 1. Cron schedules are checked
by a monitor every 30 s, so a `* * * * *` job is created up to about 30 s after the minute. Fix: at
startup `createQueue` (idempotent) every queue before `schedule` or `work`, always attach
`boss.on('error', …)`, iterate the jobs array, and don't rely on to-the-second cron timing (apps/worker).

*Source: `OBSERVED` (research sandbox, pg-boss 12.35.0 on timescale/timescaledb:2.30.1-pg17, 2026-09-28); `SOURCE` (pg-boss dist/manager.js:853, timekeeper.js:845, types.d.ts:899)*

### TOOL-1
**After `pnpm add -D typescript`, typescript-eslint or Next's type check breaks; or `tsc` fails with `TS2591 Cannot find name 'node:crypto'`, `TS5101` (baseUrl) or `TS5107` (moduleResolution node).**
The npm `latest` of typescript is 7.x, the native compiler, whose package exports no classic JS compiler
API; typescript-eslint 8.71 peers `>=4.8.4 <6.1.0`. TypeScript 6 in turn defaults `types` to `[]`, so
Node's types are missing unless listed, and turns the `baseUrl` and `moduleResolution: node`
deprecations into errors. Fix: pin `typescript` to exactly `6.0.3` (root package.json);
`"types": ["node"]`, `moduleResolution: "bundler"` and `paths` without `baseUrl` (tsconfig.base.json).

*Source: `OBSERVED` (research sandbox, `npm view typescript` = 7.0.2 and tsc 6.0.3, 2026-09-28)*

### TOOL-2
**`shadcn init` in a script exits 0 having created nothing, or `next build` fails offline with `next/font: error … fonts.googleapis.com`.**
Without `-p <preset>` (or `-d`) shadcn 4.21 opens an interactive preset picker, and with stdin closed it
exits 0 having done nothing; without `--no-monorepo` it also asks about the pnpm workspace. There is no
`--base-color` flag: the preset sets it. `init` also rewrites the root layout to load Geist through
`next/font/google`, which downloads the font at build time. Fix:
`shadcn init -t next -b radix -p nova -y --no-monorepo`; take Geist from the `geist` package (`GeistSans`
from `geist/font/sans`, apps/web/src/app/layout.tsx) and point `--font-sans` at `var(--font-geist-sans)`.

*Source: `OBSERVED` (research sandbox, shadcn 4.21.0, and Next 16.3.6 built with the network blocked, 2026-09-28)*

### TOOL-3
**ESLint crashes with `TypeError: Error while loading rule 'react/display-name': contextOrFilename.getFilename is not a function`.**
eslint-config-next 16 sets `settings.react.version: 'detect'`, and eslint-plugin-react 7.37.5 detects the
version through `context.getFilename()`, which ESLint 10 removed. Fix: set `settings.react.version`
explicitly (`'19.3'`, eslint.config.js); every plugin family then fires under ESLint 10. In a root config,
eslint-config-next's ignores are relative to the config file (re-declare `**/.next/**`) and
`settings.next.rootDir` must be absolute. The fallback is ESLint 9, which create-next-app pins.

*Source: `OBSERVED` (research sandbox, ESLint 10.11.0 with eslint-config-next 16.3.6, 2026-09-28); `SOURCE` (eslint-plugin-react lib/util/version.js:31)*

### TOOL-4
**The tsup-bundled worker crashes at start with `Error: Dynamic require of "events" is not supported`, or with `ReferenceError: __dirname is not defined in ES module scope` from pino.**
With `noExternal: [/.*/]`, CJS dependencies such as `pg` are inlined into an ESM file, where their
`require('events')` finds no `require`. pino transports (`pino-pretty`) start a worker thread through
thread-stream, which needs `__dirname`. Fix: the tsup banner
`import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);` with
`external: ['pg-native']`; in the worker plain `pino()` to stdout (`redact` works bundled), and
`tsx src/main.ts | pino-pretty` in development.

*Source: `OBSERVED` (research sandbox, tsup 8.5.1, pg 8.23.0, pino 10.3.1, 2026-09-28)*

### TOOL-5
**`node_modules/.pnpm` holds several `drizzle-orm@0.45.3_<peers>` directories, and workspace packages resolve different ones.**
pnpm creates one instance of a package per distinct set of resolved optional peers. drizzle-orm has many
(`@opentelemetry/api`, `kysely` via better-auth, `@types/pg`, `pg`), and a package that doesn't see one of
them gets its own copy: separate module instances with separate classes and type declarations, so a `db`
or table built in one package can disagree with another package's copy (the Better Auth adapter, for one).
Fix: install those peers as root devDependencies (package.json: `@opentelemetry/api`, `kysely`,
`@types/pg`, `pg`) so every package resolves the same variant; check with
`readlink <package>/node_modules/drizzle-orm` and the lockfile's single `drizzle-orm@0.45.3(…)` snapshot.
Stale variant directories under `.pnpm` can linger until a prune.

*Source: `OBSERVED` (this repository: `node_modules/.pnpm` had four `drizzle-orm@0.45.3_*` variants until the peers were added to the root devDependencies, 2026-09-28)*

### TOOL-6
**A Docker build on `node:26-alpine` fails with `sh: corepack: not found`.**
corepack ships with `node:24-alpine` and `node:22-alpine` (0.36.0) but not with `node:26-alpine`, so
`corepack enable`, which installs the pnpm pinned in `packageManager`, fails. Fix: base images on
`node:24-alpine` (Dockerfile). Docker Hub may answer 429 in sandboxes and CI;
`mirror.gcr.io/library/node:24-alpine` is the same image.

*Source: `OBSERVED` (research sandbox, `node:22-alpine`, `node:24-alpine` and `node:26-alpine`, 2026-09-28)*

### TOOL-7
**After `pnpm format`, `tools/check_gotchas.py` reports `has no '*Source: ...*' line` for every entry, and doc tables are re-padded.**
Prettier formats Markdown by default: it rewrites `*emphasis*` to `_emphasis_` and re-aligns table cells.
The registry validator looks for the literal `*Source: …*` line of each entry, so one repo-wide
`prettier --write .` fails every entry (the PostToolUse hook only runs after Edit/Write, not after a
shell command, so nothing flags it until CI). Fix: `**/*.md` is in `.prettierignore`; if Markdown was
already rewritten, `git checkout -- docs/` and re-run `python3 tools/check_gotchas.py`.

*Source: `OBSERVED` (this repo, `pnpm format` with prettier 3.9.9, 2026-09-28)*

### ZOD-1
**Unknown or new fields in a plugin payload vanish after parsing: stored event data lacks keys the plugin sent.**
In zod 4, `z.object()` strips unknown keys, at every nesting level. `z.looseObject()` keeps them, and it
has to be used for each nested object too. Fix: payload schemas use `z.looseObject` at every level
(packages/core/src/payload/parse.ts), and event data is stored from the raw parsed JSON, not from zod's
output.

*Source: `OBSERVED` (research sandbox, zod 4.6.5, 2026-09-28)*
