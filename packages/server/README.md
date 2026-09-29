# @hub/server

The hub's server-side services: everything `apps/web` route handlers and `apps/worker` jobs do, as
plain functions over a `Db` from `@hub/db`. The app and worker only adapt HTTP requests and pg-boss
jobs to these calls. The decisions come from `@hub/core` (parsing, planning, permissions); this package
does the reads, the writes and the locking. The design is `docs/design/HANDOFF-draft2.md`, and
`docs/ARCHITECTURE.md` (decision log D-1…) records where the build departs from it.

## Modules

| Directory | What it does |
| --- | --- |
| `ingest/` | `POST /api/osrs-data/events`: device auth, rate limits, the raw-payload archive, and one transaction per payload (`store.ts`). `lock.ts` holds the per-account lock; `chunks.ts` holds the shared chunk-creation lock. |
| `pairing/` | Wizard pairing codes and `POST /pair` (limits, lockout, token issue). |
| `devices/` | The Devices page: list, rename, revoke. |
| `accounts/` | Read models (dashboard, account page, guild feed, history, XP periods) and the permission inputs (`loadViewer`, `loadAccountAccess`). |
| `sharing/` | Audiences, grants, ownership transfer and claim, blocking and removing contributors. |
| `live/` | The LISTEN client, the in-memory `LiveHub` fan-out to SSE streams, and the `Last-Event-ID` replay and polling fallback (`replayEvents`, `settledLiveCursor`). |
| `offboarding/` | Offboarding, restore, grace expiry and the orphaned-account purge (handoff §14, D-61), and what a sign-in does to the user's row (`recordSignIn`, D-35). `accounts.ts` holds the ownership rules: choosing a successor, moving ownership, and the D-60 takeover of accounts hidden because their owner is in grace. |
| `jobs/` | The worker's jobs: closing stale play sessions, Discord re-verification with its two circuit breakers, and audit-log pruning. |
| `discord/` | The Discord API client (member lookups with the bot token or the user's OAuth token, the current user) and the membership verdict. |
| `settings/` | User settings and the decommission switch. |
| `admin/` | Admin read models (users, ingest health, raw payloads, the audit log) and admin actions. |
| `api/` | The public API v1 (M3): API keys (create, list, revoke, authenticate; D-69), key access on the shared loaders (D-70), one read model per `/api/v1` endpoint, the `/events` cursor feed (settled prefix, D-73) and `/snapshot` (D-74), and the in-memory rate limits (D-72). The web layer maps these camelCase shapes to snake_case (D-77). |
| top-level files | `logger.ts` (pino, redaction; `HUB_SERVICE` names the process), `metrics.ts` (prom-client), `notify.ts` (`pg_notify` inside the writing transaction, D-32), `audit.ts`, `feed.ts` (event redaction for viewers), `health.ts` (`pingDatabase` for `/api/health`). |

`src/index.ts` re-exports every directory. Tests run against a real database, one per test file
(`createTestDatabase` from `@hub/db/testing`): `pnpm vitest run --project server`.

## Expect these

Facts about this package only. Traps of the shared layer are in `docs/gotchas/` and cited by ID.

- **Any new writer of an account's rows takes `lockAccount` first** (`ingest/lock.ts`, ingest's
  per-account advisory lock), and keeps the lock order every writer follows: the acting user's row
  (ingest `FOR SHARE`, offboarding and restore `FOR NO KEY UPDATE`) → the account locks, ascending
  ids → the rows, with `osrs_accounts` written as late as possible. Writes that may create a hypertable
  chunk (`xp_samples`, `location_samples`) go behind the shared chunk lock in `ingest/chunks.ts`
  (TSDB-12, D-58). Never lock a user row after an account lock: offboarding and restore hold the
  user's row while they wait for the account lock, so that order deadlocks. Read the owner's status
  instead, as `offboarding/accounts.ts` `takeOverFromOwnerInGrace` does.
- **Ingest's name-only fallback** (a payload with a name but no `accountHash`) matches only accounts
  the reporting user is already linked to. Display names are public, so matching every account
  would let anyone attach themselves to someone else's account.
- **The live hub re-reads the subscribed users before each fan-out.** A status or admin change
  reaches an open stream with the next notification, not at once. A user who is no longer active
  loses the stream then. The toast filter is fixed until the next stream.
- **Replay serves only the settled seq prefix** (DB-4). The polling fallback passes
  `LIVE_POLL_SETTLE_MS` (10 s), so a poll holds back rows younger than that and anything above them.
  The SSE replay passes 0, because the stream has already subscribed. A first poll's cursor comes from
  `settledLiveCursor` and is 0 on a hub without events; 0 is a real cursor to replay after (D-65).
- **`PresenceMessage.onlineForMs`**: nothing is sent when presence times out (a crash or a hop to a
  special world just stops the payloads). A client marks the account offline `onlineForMs` after it
  received the message. The value is relative, so the browser's clock doesn't matter.
- **Accounts hidden because their owner is in grace come back** (D-60). An active, non-blocked
  contributor takes one over when they are restored (`restoreUser`, whose `unhidden` includes those
  accounts) or when they report it (ingest). Each takeover is audited as
  `account.ownership_transferred` with reason `owner_in_grace`.
- **Re-verification's rolling breaker reads the audit log.** It counts `user.offboarded` entries
  with actor label `worker` (and no actor user) from the last `intervalHours` whose user is still in
  grace for `left_guild`/`lost_role`. If that label or entry changes, the breaker stops counting.
- **Database errors are logged by code** (`pgErrorCode`, `safeDbErrorMessage`), never by message.
  A drizzle error's message lists the bound parameters (DB-3).
- **An API key is its creator minus powers** (D-70). The shared loaders (`accounts/load.ts`) take
  an optional `AccessRestriction`: account scope and categories are intersected with
  `resolveAccess`, the admin override is off and `canManage` is false. Every read model the API
  reuses takes it as its last parameter; never load an account for the API without it.
- **The `/snapshot` ETag hashes the response** (key id plus content), not the newest change time:
  `online` and `stale` change with the clock alone, and a sharing change alters the response without
  new data. `since` re-sends accounts changed up to 30 s before it (`updated_at` is the receive time
  and may commit late, DB-4), and always returns accounts whose `activity` the key can't read.
- **The `/events` feed uses the live replay's settle margin** (`LIVE_POLL_SETTLE_MS`, 10 s) against
  `inserted_at` (database clock), and bounds its scan with `seqFloor`, which compares `received_at`
  to the caller's `now`. Tests on a fake clock must settle their rows explicitly.
