# Next.js 16

Next.js 16 (route handlers, server actions, RSC, proxy.ts, instrumentation, basePath, standalone output, the dev and build CLI).

| ID | Symptom |
|---|---|
| [NEXT-1](#next-1) | Changing `basePath` or an `APP_URL` path prefix at runtime has no effect: the app still answers on the prefix it was built with and 404s on the new one. |
| [NEXT-2](#next-2) | Redirects and absolute URLs built in a route handler point at `http://0.0.0.0:3000/…` or `localhost` instead of the public host. |
| [NEXT-3](#next-3) | A module-level singleton exists twice: state set in a route handler reads empty in a page or server action (or in instrumentation), or two DB pools appear. |
| [NEXT-4](#next-4) | A large request body arrives cut off at 10 MB and the handler returns 200 on the partial data; the log says `Request body exceeded 10MB for /… Only the first 10MB will be available`. |
| [NEXT-5](#next-5) | Every Server Action (creating a pairing code, for one) fails with 500 `Invalid Server Actions request` behind the reverse proxy; the log says `x-forwarded-host` does not match `origin`. |
| [NEXT-6](#next-6) | `AGENTS.md` and `CLAUDE.md` appear in the app directory after `next dev`, and the log says `Generated AGENTS.md and CLAUDE.md for AI agents`. |
| [NEXT-7](#next-7) | A CI step running `next lint` passes even on code with lint errors, printing `Invalid project directory provided … /lint`. |
| [NEXT-8](#next-8) | `tsc` on a fresh checkout fails with `Cannot find name 'PageProps'` or `Cannot find name 'RouteContext'`. |
| [NEXT-9](#next-9) | The web container serves requests through its published port, but a localhost healthcheck inside it (`wget http://127.0.0.1:3000`) is refused. |
| [NEXT-10](#next-10) | `next build` fails with `Module not found: Can't resolve './hash.js'` for an import inside a TS-source workspace package, while tsc, tsx and vitest accept it. |
| [NEXT-11](#next-11) | `next build` fails at "Collecting page data" with `Failed to collect configuration for /<route>`, caused by `TypeError: The "path" argument must be of type string. Received undefined` at a `path.join(import.meta.dirname, …)` in a workspace package. |
| [NEXT-12](#next-12) | The browser downloads a ~440 KB chunk containing `crypto-browserify`, and `next build` passes without a warning, after a `'use client'` component imports one small helper from a workspace package whose index also re-exports a module that imports `node:crypto`. |
| [NEXT-13](#next-13) | Every request to a route handler that copies its request with `new Request(request, …)` (Better Auth's `/api/auth/*`, for one) answers 500 on Node 24, logging `TypeError: Cannot read private member #state from an object whose class did not declare it`, while the same code passes on Node 22 and in unit tests. |
| [NEXT-14](#next-14) | An unknown id's page shows the not-found UI but answers HTTP 200, with `<meta name="robots" content="noindex">` in its HTML, while a `notFound()` from a layout answers 404. |
| [NEXT-15](#next-15) | `pnpm dev` or a tsx script in a workspace package ignores the repo-root `.env` (`DATABASE_URL is not set`), and starting Next as `node --env-file=… next dev` exits at once with code 9: `--env-file-if-exists= is not allowed in NODE_OPTIONS`. |
| [NEXT-16](#next-16) | A streamed download logs an error such as `export: failed while streaming` with `TypeError: Invalid state: Controller is already closed` whenever the client cancels it halfway (a closed tab, an aborted `fetch`). |

### NEXT-1
**Changing `basePath` or an `APP_URL` path prefix at runtime has no effect: the app still answers on the prefix it was built with and 404s on the new one.**
`basePath` is read at build time: it is baked into `server.js` and inlined into client chunks
(basePath.md:18, "must be set at build time"). A prebuilt image can't honour a prefix from env, and route
handlers see `nextUrl.pathname` without the prefix. Fix: the hub is served at the origin root; `APP_URL`
must be an origin without a path, and config validation rejects anything else
(packages/core/src/config.ts, D-26). A prefix would need a build arg and an image per deployment.

*Source: `OBSERVED` (research sandbox, Next 16.3.6 built with `BASE_PATH=/hub`, run with `/other`, 2026-09-28); `DOCS` (next/dist/docs basePath.md:18)*

### NEXT-2
**Redirects and absolute URLs built in a route handler point at `http://0.0.0.0:3000/…` or `localhost` instead of the public host.**
In route handlers `request.url` and `nextUrl.origin` carry the server's bind address (standalone:
`http://0.0.0.0:<port>`, `next start`: `localhost`) and ignore `Host` and `X-Forwarded-Host`; only
`X-Forwarded-Proto` is honoured. `NextResponse.redirect(new URL('/x', request.url))` sends users to
0.0.0.0. Fix: build every absolute URL (wizard URL, OAuth callbacks, redirects, Better Auth `baseURL`)
from `APP_URL` as parsed in packages/core/src/config.ts.

*Source: `OBSERVED` (research sandbox, Next 16.3.6 standalone and `next start`, 2026-09-28)*

### NEXT-3
**A module-level singleton exists twice: state set in a route handler reads empty in a page or server action (or in instrumentation), or two DB pools appear.**
The Node server loads route handlers in one module instance, RSC pages together with server actions in
another, and `instrumentation-node` in another again; only `globalThis` is shared. Anything that must be
one per process lives on `globalThis` under a unique key: the DB pool ([DB-5](database.md#db-5)), the SSE
fan-out hub and its LISTEN client, rate limiters, the metrics registry, the pairing notifier. Fix:
`getDb()` keeps the pool on `globalThis.__hubDb` (packages/db/src/client.ts), the pattern for the rest.
`instrumentation.ts` itself is also compiled for Edge: keep Node APIs out of it and import the Node part
dynamically behind `process.env.NEXT_RUNTIME === 'nodejs'`.

*Source: `OBSERVED` (research sandbox, Next 16.3.6 standalone: route handlers, an RSC page, a server action and instrumentation compared, 2026-09-28)*

### NEXT-4
**A large request body arrives cut off at 10 MB and the handler returns 200 on the partial data; the log says `Request body exceeded 10MB for /… Only the first 10MB will be available`.**
For every path matched by `proxy.ts` (formerly middleware) Next clones the request body into memory
before the handler runs, up to `experimental.proxyClientMaxBodySize` (default 10 MB), and truncates
silently past it: a 12,000,000-byte POST read back as 10,485,760 bytes. It also defeats a streaming body
cap, since the body is already buffered. Fix: exclude `/api/osrs-data`, `/api/v1` and `/api/live` from any
proxy matcher, or have no `proxy.ts`; the ingest cap is enforced while streaming (413).

*Source: `OBSERVED` (research sandbox, Next 16.3.6 `next start`, 2026-09-28)*

### NEXT-5
**Every Server Action (creating a pairing code, for one) fails with 500 `Invalid Server Actions request` behind the reverse proxy; the log says `x-forwarded-host` does not match `origin`.**
Next compares the `Origin` header with `X-Forwarded-Host`, or with `Host` when that is absent
(action-handler.js:351-372,438-460). A proxy that rewrites `Host` to the upstream (`web:3000`) without
setting `X-Forwarded-Host` fails the check; adding the header makes it pass. `serverActions.allowedOrigins`
is build-time config, so it is no env-only fix. Fix: the reverse proxy passes the original `Host` or sets
`X-Forwarded-Host` (docs/OPERATIONS.md §3).

*Source: `OBSERVED` (research sandbox, Next 16.3.6 standalone, 2026-09-28); `SOURCE` (next/dist/server/app-render/action-handler.js:351-372,438-460)*

### NEXT-6
**`AGENTS.md` and `CLAUDE.md` appear in the app directory after `next dev`, and the log says `Generated AGENTS.md and CLAUDE.md for AI agents`.**
`next dev` writes them whenever it detects an AI agent through the `CLAUDECODE` or `AI_AGENT`
environment variables (start-server.js:416-428). Fix: `agentRules: false` in apps/web/next.config.ts.

*Source: `OBSERVED` (research sandbox, Next 16.3.6, 2026-09-28); `SOURCE` (next/dist/server/lib/start-server.js:416-428)*

### NEXT-7
**A CI step running `next lint` passes even on code with lint errors, printing `Invalid project directory provided … /lint`.**
`next lint` was removed in Next 16, and `next build` no longer lints. The CLI now treats `lint` as a
project directory, prints the error and exits 0. Fix: run `eslint .` from the repository root (the root
`lint` script and eslint.config.js).

*Source: `OBSERVED` (research sandbox, Next 16.3.6, 2026-09-28)*

### NEXT-8
**`tsc` on a fresh checkout fails with `Cannot find name 'PageProps'` or `Cannot find name 'RouteContext'`.**
The global `PageProps<'/route'>` and `RouteContext<'/route'>` helpers are generated under `.next/types`
by `next typegen` or `next build`, and `next-env.d.ts` is regenerated too (gitignored). Fix: the web
typecheck script is `next typegen && tsc -p tsconfig.json` (apps/web/package.json); CI runs typegen before
type-aware ESLint as well.

*Source: `OBSERVED` (research sandbox, Next 16.3.6, 2026-09-28)*

### NEXT-9
**The web container serves requests through its published port, but a localhost healthcheck inside it (`wget http://127.0.0.1:3000`) is refused.**
The standalone `server.js` binds to `process.env.HOSTNAME || '0.0.0.0'`, and Docker sets `HOSTNAME` to
the container id, so the server listens on the container's IP only. Fix: `ENV HOSTNAME=0.0.0.0` in the web
image (Dockerfile); the image's value wins over Docker's runtime one. Alpine images have busybox `wget`
but no `curl` for healthchecks.

*Source: `OBSERVED` (research sandbox, Next 16.3.6 standalone in `node:24-alpine`, 2026-09-28)*

### NEXT-10
**`next build` fails with `Module not found: Can't resolve './hash.js'` for an import inside a TS-source workspace package, while tsc, tsx and vitest accept it.**
NodeNext-style `.js` specifiers that point at `.ts` sources aren't resolved by Turbopack or webpack for
workspace packages, and `transpilePackages` doesn't help. `.ts` specifiers work only with
`allowImportingTsExtensions`. Fix: extensionless relative imports with `moduleResolution: "bundler"`
(tsconfig.base.json) in every package.

*Source: `OBSERVED` (research sandbox, Next 16.3.6 with Turbopack and `--webpack`, an import-style matrix across tsc, tsx, tsup, vitest and node, 2026-09-28)*

### NEXT-11
**`next build` fails at "Collecting page data" with `Failed to collect configuration for /<route>`, caused by `TypeError: The "path" argument must be of type string. Received undefined` at a `path.join(import.meta.dirname, …)` in a workspace package.**
Turbopack compiles `import.meta` in server bundles to an object with only a `url` getter and `env`
(`{ get url(){…}, env: { … } }` in the emitted chunk), so `import.meta.dirname` and `import.meta.filename`
are `undefined`. Node, tsx and vitest provide them (and tsc accepts them), so the code works everywhere
until a route handler imports the module: a top-level `path.join(import.meta.dirname, '..',
'drizzle')` in packages/db/src/migrate.ts breaks every route that imports `@hub/db`, even though the web
app never migrates. packages/fixtures/src/index.ts has the same pattern. Fix: in any package the web app
imports, don't read `import.meta.dirname`/`filename` at module top level; derive the path from
`import.meta.url` (the build passes with `path.dirname(new URL(import.meta.url).pathname)`, and with
`path.dirname(fileURLToPath(import.meta.url))`, which packages/db/src/migrate.ts uses because it also
decodes `%20`), or resolve it lazily inside the function that needs it. Not `new URL('../drizzle', import.meta.url)`: Turbopack takes
that form for an asset import and fails with `Module not found: Can't resolve '../drizzle'`. Compare
([NEXT-10](#next-10)), the other workspace-package trap only `next build` shows.

*Source: `OBSERVED` (apps/web `next build`, Next 16.3.6 Turbopack, 2026-09-29: fails with the migrate.ts line, passes with it derived from `import.meta.url`, both forms)*

### NEXT-12
**The browser downloads a ~440 KB chunk containing `crypto-browserify`, and `next build` passes without a warning, after a `'use client'` component imports one small helper from a workspace package whose index also re-exports a module that imports `node:crypto`.**
Turbopack does not fail on Node built-ins in client bundles: it substitutes browser polyfills
(`node:crypto` becomes crypto-browserify, missing exports such as `randomInt` just come out
`undefined`). And a package whose `package.json` doesn't declare `"sideEffects": false` can't have the
unused modules of an `export *` barrel dropped, so importing `relativeTime` from `@hub/core` in a client
component ships `crypto.ts` (and the polyfill) with it; the same goes for zod via `config.ts`. Nothing
breaks, so it only shows as bundle size. Fix: `"sideEffects": false` in the workspace package's
`package.json` (verified: the polyfill chunk disappears; packages/core has it), or give client code an
entry point that doesn't reach Node-only modules. Never value-import `@hub/server` or `@hub/db` from client code at all;
type-only imports must be written `import type { … }`, because under `verbatimModuleSyntax`
`import { type X }` still emits a bare `import '<pkg>'`. Compare ([NEXT-10](#next-10)), another
Turbopack behaviour specific to TS-source workspace packages.

*Source: `OBSERVED` (scratch Next 16.3.6 Turbopack app, 2026-09-29: a client component importing a barrel that re-exports a `node:crypto` module produced a 439,080-byte chunk with crypto-browserify; the same package with `"sideEffects": false` produced none; apps/web, 2026-09-29: an 839,174-byte client chunk with crypto-browserify and zod gone after adding it to packages/core, static chunks 2.7 MB → 1.9 MB)*

### NEXT-13
**Every request to a route handler that copies its request with `new Request(request, …)` (Better Auth's `/api/auth/*`, for one) answers 500 on Node 24, logging `TypeError: Cannot read private member #state from an object whose class did not declare it`, while the same code passes on Node 22 and in unit tests.**
Next 16 doesn't hand an App Router route handler the request itself: `proxyNextRequest()` (in
`next/dist/server/route-modules/app-route/module.js`) wraps it in a `Proxy`. The undici bundled
with Node 24 keeps a Request's state in real `#private` fields and reads them straight off the `input`
of `new Request(input, init)`, and a Proxy has none of its target's private fields, so the copy throws.
Node 22's undici kept that state under symbol keys, which pass through the proxy's `get` trap, so the
copy works there. That covers local runs and any test that passes a plain `Request`. Reading the
request's own properties (`headers`, `url`, `method`, `body`, `signal`, `text()`) works on both,
because Next's trap resolves them on the target. Fix: copy it from its parts, as in
`new Request(request.url, { method, headers, signal, body: request.body, duplex: 'half' })`, and leave
out `body`/`duplex` for GET and HEAD. The body stream moves over unread. Run the tests on the Node
version production uses: here only the Playwright job, which runs the real standalone server on Node 24,
caught it.

*Source: `SOURCE` (next 16.3.6 `app-route/module.js`: `request = proxyNextRequest(req, workStore)` → `new Proxy(request, nextRequestHandlers)`); `OBSERVED` (apps/web standalone server on Node 24.21, 2026-09-29: `POST /api/auth/sign-in/social` and `GET /api/auth/get-session` → 500 with the TypeError, fixed by copying from parts; a probe script: `new Request(new Proxy(req, …))` throws on Node 24.21 and works on 22.22)*

### NEXT-14
**An unknown id's page shows the not-found UI but answers HTTP 200, with `<meta name="robots" content="noindex">` in its HTML, while a `notFound()` from a layout answers 404.**
A `loading.tsx` is a `<Suspense>` boundary around the segment's page, and a Suspense fallback is part
of the response's first chunk: Next commits the status (200) and the headers to start streaming it,
before the page below has run. A `notFound()` thrown in the page afterwards can only swap in the
not-found UI inside the stream and inject the `noindex` tag; a `redirect()` becomes a client-side
redirect. The same happens under any `<Suspense>` the page sits in. A layout of that segment renders
outside its own `loading.tsx`, so a check there still sets the status (`requireAdmin()` in
`admin/layout.tsx`: 404). Client navigations aren't affected (no status to get wrong), and unit tests
that render the page with `renderToReadableStream` can't see it. Fix: do the existence or visibility
check at the top of the page, with no `loading.tsx` in the segment (or above it) and before any
`<Suspense>`; then render the slow parts inside `<Suspense>` with the old skeleton as fallback. Keep
the check cheap: the shell waits for it. With `cacheComponents` every dynamic route streams a static
shell first, and the docs send such checks to `proxy.ts` instead.

*Source: `DOCS` (next/dist/docs 01-app/02-guides/streaming.md "The HTTP contract", 01-app/03-api-reference/03-file-conventions/loading.md "Status Codes"); `OBSERVED` (apps/web standalone build, Next 16.3.6, 2026-09-29: `/accounts/Nothing00000` answered 200 with "Account not found" while `/accounts/[publicId]/loading.tsx` existed; `/admin/*` for a non-admin answered 404)*

### NEXT-15
**`pnpm dev` or a tsx script in a workspace package ignores the repo-root `.env` (`DATABASE_URL is not set`), and starting Next as `node --env-file=… next dev` exits at once with code 9: `--env-file-if-exists= is not allowed in NODE_OPTIONS`.** `next dev` loads `.env*` only from the app directory (`apps/web`), and tsx loads none at
all, so a `.env` at the repo root reaches neither. Node's own `--env-file`/`--env-file-if-exists` looks
like the fix and works for tsx, but it crashes `next dev`: Next re-parses its own `process.execArgv` and
hands every flag to the dev-server child through `NODE_OPTIONS` (`startServer` → `formatNodeOptions` in
`next/dist/cli/next-dev.js`), and Node refuses `--env-file*` in `NODE_OPTIONS`. Preload a module that
calls `process.loadEnvFile()` instead: `node --import=<module> node_modules/next/dist/bin/next dev`
(`--import` is allowed in `NODE_OPTIONS`; tsx and `tsx watch` pass it through too). The child is forked
with the parent's environment, so it has the variables already; it runs the preload again, harmlessly,
because `process.loadEnvFile` never overwrites a variable that is set. That rule also sets the order: load
the override file first, and the shell beats both. Next collapses a repeated flag to its last value when it
re-parses, so pass one `--import`. This repo: `tools/dev-env.mjs`.

*Source: `SOURCE` (next 16.3.6 `dist/cli/next-dev.js`, `dist/server/lib/utils.js`); `OBSERVED` (apps/web `pnpm dev`, Next 16.3.6 on Node 22.14, 2026-09-29: exit 9 with the message above; `pnpm db:migrate` stopped with `DATABASE_URL is not set` while the root `.env` set it)*

### NEXT-16
**A streamed download logs an error such as `export: failed while streaming` with `TypeError: Invalid state: Controller is already closed` whenever the client cancels it halfway (a closed tab, an aborted `fetch`).**
A route handler that returns `new Response(new ReadableStream({ async pull(c) { … } }))` gets its
`cancel()` called while a `pull` may still be awaiting its source (a database query, a generator's next
piece). When that await resolves, the pull calls `controller.enqueue`, which throws because the stream is
already closed, and a `catch` around the pull body takes that for a failure of the source: it logs an
error, counts a failure, or calls `controller.error`. Nothing was lost; the client simply stopped reading.
Fix: set a flag in `cancel()` and have the pull's `catch` return quietly when it is set, before any logging
(apps/web `api/app/export/route.ts`). A pull that is idle when the client cancels doesn't throw, so a quick
manual test that cancels between reads doesn't show it.

*Source: `OBSERVED` (apps/web `api/app/export/route.test.ts` "stops the export when the download is cancelled", Next 16.3.6 on Node 22.14, 2026-09-29: the enqueue after cancel threw the TypeError above every run)*
