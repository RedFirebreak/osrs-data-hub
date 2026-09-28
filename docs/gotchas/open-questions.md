# Open questions

Read in the docs, never seen live. No IDs, not in the index. Each bullet says what the docs claim, where
it was read, and what a live run would have to show to settle it. When one is settled it is promoted to an
entry, moved to the confirmations log, or deleted: see the `gotcha` skill. A settled question never stays
here.

- **Discord: `member.roles` never contains the @everyone role.** Claimed as common knowledge (research
  critique §3.3, 2026-09-28); not found in the docs that were checked. If it holds, the @everyone role id
  (= the guild id) in `DISCORD_REQUIRED_ROLE_IDS` would reject every member. Settle with one live member
  lookup; if confirmed, reject the guild id in that setting at startup.
- **Discord: members with `pending: true`.** The docs define `pending` as "has not yet passed the guild's
  Membership Screening requirements" (discord-api-docs@ce076f0 `developers/resources/guild.mdx:391`), and
  list `joined_at` as nullable (`?ISO8601`) while the sign-in code types it as a string. Unknown: whether
  the user-token and bot member lookups return such a member as 200 (and so pass the gate). Settle by
  looking up a screening-pending member through both routes, then decide the gate policy.
- **Discord: which error the user-token route `/users/@me/guilds/{id}/member` returns for a non-member,
  and its rate limit.** Research assumed `404` with `code 10004` and a low limit; the docs only say it
  "Requires the guilds.members.read scope" (`developers/resources/user.mdx:316-319`). Sign-in fails closed
  on any non-200, so only the error message depends on it. Settle with a live sign-in by a non-member.
  The bot route's codes are [DISCORD-1](auth.md#discord-1).
- **OkHttp may resend a POST on its own.** RuneLite's shared client has `retryOnConnectionFailure=true`,
  which can transparently retry a request after a connection failure (research inference about OkHttp
  3.14.9 internals, plugin report §5). That would add duplicate deliveries with the same `eventId`s beyond
  [PLUGIN-4](plugin.md#plugin-4); the unique event key absorbs them either way. Settle with a capture from
  a live client behind a proxy that resets connections.
- **RuneLite: one raid failure in ToA or ToB may produce two death events** (an `EXCEPTIONAL` one from
  `ActorDeath` and a `DANGEROUS` one from the fail message or HUD; also the Fortis "doomed" message). Read
  in the plugin source (DeathNotifier.java:101-134 @0ec2a36), never seen in game. Settle with captures of
  a raid wipe; if confirmed, the event feed needs to group them.
- **TimescaleDB restores need `timescaledb_pre_restore()` / `timescaledb_post_restore()` around
  `pg_restore`.** From memory of the Timescale docs (research critique §2.1), not run. Settle in the M4
  restore drill against the `backup` service's dumps.
- **GitHub Actions service containers accept `command:`.** github.com documents
  `jobs.<id>.services.<id>.command` and `.entrypoint` (github/docs@f4e8afc
  `content/actions/reference/workflows-and-actions/workflow-syntax.md:1509-1545`, fpt/ghec only); not run
  in Actions. Settle with a CI job that starts Timescale with `-c timescaledb.max_background_workers=0`
  (see [TSDB-10](database.md#tsdb-10)).
- **Better Auth `nextCookies()` inside a server action.** Its after-hook copies `Set-Cookie` from
  `auth.api.*` calls into `cookies()`, so `auth.api.signOut({ headers })` in a server action clears the
  session cookie (better-auth 1.7.6 `dist/integrations/next-js.mjs:33-103`); read in the source only.
  Settle with a sign-out through a real server action.
