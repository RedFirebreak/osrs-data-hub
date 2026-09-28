# Auth: Better Auth and the Discord API

Better Auth 1.7 (Discord provider, Drizzle adapter, hooks, sessions, endpoints) and the Discord HTTP API (OAuth, guild member lookups).

Better Auth paths are relative to the installed packages: `better-auth/dist`, `@better-auth/core/dist`,
`@better-auth/drizzle-adapter/dist` (all 1.7.6).

| ID | Symptom |
|---|---|
| [AUTH-1](#auth-1) | Every auth request (sign-in, callback, `get-session`) fails with 500 and `SchemaMismatchError` (`SCHEMA_MISMATCH`). |
| [AUTH-2](#auth-2) | Expiry checks in raw SQL (`expires_at > now()`) are off by the server's UTC offset, or sign-in throws because two `account` rows match one Discord id. |
| [AUTH-3](#auth-3) | Discord sign-in comes back with `?error=email_not_found`, or Discord's consent screen asks for the user's email although only `identify guilds.members.read` is configured. |
| [AUTH-4](#auth-4) | The `account` table holds users' Discord access and refresh tokens in plaintext, and `POST /api/auth/get-access-token` hands them to the browser. |
| [AUTH-5](#auth-5) | Fields returned from `mapProfileToUser` or `getUserInfo` (`discordId`, `roles`, …) end up null, or OAuth sign-up fails with `?error=MISSING_FIELD&error_description=<field>+is+required`. |
| [AUTH-6](#auth-6) | A user rejected at sign-in (not in the guild) still leaves `users` and `account` rows behind, with a fresh token written. |
| [AUTH-7](#auth-7) | After a sign-up that failed halfway, a `users` row exists without its `account` row. |
| [AUTH-8](#auth-8) | A session deleted from the database (sign-out everywhere, offboarding) keeps working in the browser for up to 5 minutes. |
| [AUTH-9](#auth-9) | Behind the reverse proxy, Better Auth rate-limits all users together: one busy client gets everyone 429s. |
| [AUTH-10](#auth-10) | A signed-in user renames themselves with `POST /api/auth/update-user`, overriding the name that comes from Discord. |
| [DISCORD-1](#discord-1) | Re-verification marks every member, or a large share of them, as having left the guild in a single run. |

### AUTH-1
**Every auth request (sign-in, callback, `get-session`) fails with 500 and `SchemaMismatchError` (`SCHEMA_MISMATCH`).**
Better Auth 1.7 checks the Drizzle schema object passed to the adapter against its config at runtime
(`advanced.database.validateSchema`, default true; api/index.mjs:169-170). An `additionalFields` entry
added, or a column renamed, without regenerating the schema breaks login for everyone. The check covers
names and required columns, not types ([AUTH-2](#auth-2)). Fix: change the auth config and
packages/db/src/schema/auth.ts together: regenerate with `npx auth generate` (the 1.7 CLI is the `auth`
package; `@better-auth/cli@latest` is the deprecated 1.4.21), re-apply the hand edits, then
`drizzle-kit generate`. Don't copy schemas from 1.7.0 to 1.7.2, which briefly required an
`account.issuer` column.

*Source: `OBSERVED` (research sandbox, better-auth 1.7.6 probe P11 on postgres:17-alpine, 2026-09-28); `SOURCE` (better-auth api/index.mjs:169-170, drizzle-adapter index.mjs:575)*

### AUTH-2
**Expiry checks in raw SQL (`expires_at > now()`) are off by the server's UTC offset, or sign-in throws because two `account` rows match one Discord id.**
The generated schema uses `timestamp` without time zone. Drizzle writes `toISOString()` (UTC wall time)
and reads it back as UTC (pg-core/columns/timestamp.js:30-36), so Drizzle alone round-trips, but raw SQL
compares that wall time with `now()` in the session's TimeZone: under `Europe/Amsterdam` a value one hour
ahead already counted as expired. The generated schema also has no unique index on
`(provider_id, account_id)`, and Better Auth throws when two rows match (internal-adapter.mjs:555). Fix:
`{ withTimezone: true }` on every timestamp and `uniqueIndex('account_provider_account_uidx')`
(packages/db/src/schema/auth.ts); the runtime schema check doesn't look at types.

*Source: `OBSERVED` (research sandbox, postgres:17-alpine with TimeZone `Europe/Amsterdam`, 2026-09-28); `SOURCE` (drizzle-orm 0.45.3 pg-core/columns/timestamp.js:30-36, better-auth db/internal-adapter.mjs:555)*

### AUTH-3
**Discord sign-in comes back with `?error=email_not_found`, or Discord's consent screen asks for the user's email although only `identify guilds.members.read` is configured.**
The Discord provider always requests `["identify","email"]` and appends the configured `scope`
(social-providers/discord.mjs:13-15) unless `disableDefaultScope: true`. Without an email the callback
redirects with `email_not_found` before any database write (api/routes/callback.mjs:166-169), and
`users.email` is NOT NULL UNIQUE. Fix: `disableDefaultScope: true` with
`scope: ["identify", "guilds.members.read"]`, and the provider's `getUserInfo` returns the placeholder
`<discordId>@discord.invalid` (`.invalid` is a reserved TLD); packages/db/src/schema/auth.ts records it.

*Source: `OBSERVED` (research sandbox, better-auth 1.7.6 probes P8a and P8c, 2026-09-28); `SOURCE` (@better-auth/core social-providers/discord.mjs:13-15, better-auth api/routes/callback.mjs:166-169)*

### AUTH-4
**The `account` table holds users' Discord access and refresh tokens in plaintext, and `POST /api/auth/get-access-token` hands them to the browser.**
`account.encryptOAuthTokens` defaults to false (types/init-options.d.mts:1165), the tokens are rewritten
on every sign-in, and the account endpoints (`/get-access-token`, `/refresh-token`, `/account-info`)
return or refresh them for the signed-in user. The hub needs the user token only during the sign-in gate;
the worker uses the bot token. Fix: `databaseHooks.account.create.before` and `update.before` null every
token field, and those endpoints are in `disabledPaths` (a plain 404); the token columns stay null
(packages/db/src/schema/auth.ts).

*Source: `OBSERVED` (research sandbox, better-auth 1.7.6 probes P16 and P17, 2026-09-28); `SOURCE` (@better-auth/core types/init-options.d.mts:1165)*

### AUTH-5
**Fields returned from `mapProfileToUser` or `getUserInfo` (`discordId`, `roles`, …) end up null, or OAuth sign-up fails with `?error=MISSING_FIELD&error_description=<field>+is+required`.**
Values for `additionalFields` declared `input: false` are filtered out of the provider mapping
(db/schema.mjs:116-127) and silently dropped; a field that is `required: true, input: false` without a
`defaultValue` then fails validation (db/schema.mjs:103-106). Values set in `databaseHooks` aren't
filtered. Fix: write `input: false` fields from `databaseHooks.user.create.before` (and refresh them in
`session.create.before`); give required ones a `defaultValue`, and keep `discordId` `required: false`.

*Source: `OBSERVED` (research sandbox, better-auth 1.7.6 probes P8b and P9, 2026-09-28); `SOURCE` (better-auth db/schema.mjs:103-127)*

### AUTH-6
**A user rejected at sign-in (not in the guild) still leaves `users` and `account` rows behind, with a fresh token written.**
`databaseHooks.session.create.before` runs after the user and account were created (new user) or the
tokens updated (returning user): throwing there gives the right `?error=<code>` redirect but keeps those
rows. `user.validateUserInfo` (new in 1.7) runs before any write for new users and before the token update
for returning ones; returning `{ error, errorDescription }` redirects to
`errorCallbackURL?error=<code>&error_description=…`. A rejected sign-in also doesn't revoke the user's
existing sessions. Fix: fetch the guild member in the provider's `getUserInfo` (the only place with the
fresh token) and decide in `user.validateUserInfo`; offboarding deletes sessions itself.

*Source: `OBSERVED` (research sandbox, better-auth 1.7.6 probes P1 to P7 and the flow tests, 2026-09-28); `SOURCE` (better-auth oauth2/link-account.mjs:190-306)*

### AUTH-7
**After a sign-up that failed halfway, a `users` row exists without its `account` row.**
The Drizzle adapter's `transaction` option defaults to false (drizzle-adapter index.d.mts:37-43,
index.mjs:559), so the user insert, the account insert and their hooks don't share a transaction. Fix:
`drizzleAdapter(db, { provider: 'pg', schema, transaction: true })`; a failure then leaves nothing.

*Source: `OBSERVED` (research sandbox, better-auth 1.7.6 probe P10, 2026-09-28); `SOURCE` (@better-auth/drizzle-adapter index.mjs:559)*

### AUTH-8
**A session deleted from the database (sign-out everywhere, offboarding) keeps working in the browser for up to 5 minutes.**
With `session.cookieCache` enabled, `getSession` trusts the signed cookie until its `maxAge` (default
300 s) without reading the session row. With it off (the default) every `getSession` reads the row, so a
`DELETE FROM session WHERE user_id = $1` from the worker revokes instantly. Fix: keep `cookieCache` off
and don't configure `secondaryStorage`.

*Source: `OBSERVED` (research sandbox, better-auth 1.7.6 probe P15, 2026-09-28)*

### AUTH-9
**Behind the reverse proxy, Better Auth rate-limits all users together: one busy client gets everyone 429s.**
The client IP is taken from `x-forwarded-for`; with more than one hop and
`advanced.ipAddress.trustedProxies` unset it resolves to null (utils/ip.mjs:174-219), and the rate limiter
(on in production, 100 requests per 10 s, in memory) puts every client in one bucket per path
(api/rate-limiter/index.mjs:239-243). Fix: set `advanced.ipAddress.trustedProxies` to the proxy's address
or CIDR, consistent with the hops the hub's own limiters trust (`TRUST_PROXY_HOPS`, docs/OPERATIONS.md §3).

*Source: `SOURCE` (@better-auth/core utils/ip.mjs:174-219, better-auth api/rate-limiter/index.mjs:239-243)*

### AUTH-10
**A signed-in user renames themselves with `POST /api/auth/update-user`, overriding the name that comes from Discord.**
`input: false` protects the additional fields (`{ isAdmin: true }` gets `400 FIELD_NOT_ALLOWED`; a falsy
value is silently skipped), but the core `name` field stays writable by the user (200). Fix:
`/update-user`, with `/change-email`, `/link-social` and `/unlink-account`, is in `disabledPaths`; names
and avatars come only from Discord, through the hooks.

*Source: `OBSERVED` (research sandbox, better-auth 1.7.6 probe P19, 2026-09-28)*

### DISCORD-1
**Re-verification marks every member, or a large share of them, as having left the guild in a single run.**
`GET /guilds/{guild}/members/{user}` with the bot token answers 404 both for a user who isn't a member
(`code 10007`, Unknown Member) and, since January 2023, for a bot that isn't in the guild or a wrong
`DISCORD_GUILD_ID` (`code 10004`, Unknown Guild, where it used to be `403 50001`). Treating any 404 as
"left" offboards everyone once the bot is kicked or the id is wrong. Fix: offboard only on a 404 with
`code === 10007`; any other 404 code, 401, 403 or 5xx fails open and alerts; stop the run when more than
about 20% of users come back as non-members. Not yet observed live (no bot token was available): the
codes are from the docs, the 10004 behaviour from discord-api-docs issue #5840 (closed "not planned"),
and 10007 for a departed user from community reports.

*Source: `DOCS` (discord-api-docs@ce076f0 developers/topics/opcodes-and-status-codes.mdx:144,147; discord-api-docs issue #5840)*
