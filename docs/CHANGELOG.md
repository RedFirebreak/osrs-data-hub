# Changelog

Changes are consolidated per pull request, newest first. Each entry names the PR (or branch while it is
open), what changed, and any decision (`D-n`, see [ARCHITECTURE.md](ARCHITECTURE.md#decision-log)) or
gotcha (`AREA-n`, see [gotchas](gotchas/README.md)) it introduced.

## Unreleased — V1 scaffold (branch `red/eloquent-johnson-yufg78`)

- Bootstrapped the gotcha registry (`docs/gotchas/`, `tools/check_gotchas.py`) and the project hook
  that validates it after markdown edits.
- Archived the design handoff (draft 2) at `docs/design/HANDOFF-draft2.md` and recorded its settled
  decisions as D-1 … D-25 in `docs/ARCHITECTURE.md`.
- Web shell: login with clear guild/role/Discord-outage messages, the signed-in layout (navigation,
  user menu, live-connection indicator), the dashboard (live "Online now", account cards, empty state
  pointing at the wizard), Settings (toast filter and time zone via `PATCH /api/app/settings`, D-36),
  the public privacy page (retention from config, sharing defaults, D-4, D-22), and the browser's live
  client with toasts (ARCHITECTURE §10). Shared components for events, accounts and live presence.
  Recorded NEXT-12 (client components importing `@hub/core` ship a `node:crypto` polyfill).
  Review fixes: real headings on the login page (h1), dashboard cards and Settings sections
  (`AccountCard` takes `headingLevel`); the privacy page now says what admins can see (every account
  exists, sharing changes, audited raw payloads) and what does not come back after returning to the
  guild (devices, transferred accounts, admin removals); the minimum loot value refuses a decimal comma
  ("1,5m") instead of reading it as 15M; page-level tests for who reaches the login, dashboard,
  Settings and layout.
