## Self documenting

Update documentation in the `docs/` folder while making changes to the project. Use the following structure:

- `docs/ARCHITECTURE.md`: Use this file for architectural decisions, high level design and design of the project.

There is no changelog file: the change history is git (commit messages and pull requests). Do not create one.

## Gotchas

Known traps in the shared layer (framework, API, platform, toolchain) are recorded in
`docs/gotchas/`, one entry per trap under a permanent ID like `HTTP-4`.

**Before debugging anything that smells like a quirk rather than a bug in our code**, open
`docs/gotchas/README.md` and match what you're seeing against the symptom column of the index.
Then open only the one area file that entry points to. Don't read the directory wholesale; the
index is the way in.

**When something has cost more than ~10 minutes and would bite another <unit> too**, use the
`gotcha` skill to record it before moving on. That applies even mid-task, even if the fix was
small. If it's only true of this one <unit>, or only read in docs and never seen, the README's
routing table says where it goes instead.

**Cite by ID.** When code works around a known trap, say so in a comment:
`// See HTTP-4: read timeout must be set explicitly`. The same goes for commit messages and
other docs. Never cite a number from the README's "Retired IDs" table.

**Never renumber, and never hand-edit counts without running the check.**
`python tools/check_gotchas.py` must print `OK`; a hook runs it after markdown edits, and a
failure it reports is yours to fix before continuing.

## Chain tests: the hub with what feeds it and what reads it

The hub sits between the plugin and its consumers (the guild live map, Home Assistant). `pnpm test`
covers the hub alone. Whether a change still works for the others is checked in the dev stack: the
`osrs-dev-stack` repository, checked out next to this one (`../osrs-dev-stack/README.md`). It runs
this checkout on http://localhost:3200 with its own database and a fake Discord, fed by a fake plugin
that keeps three made-up players alive. It never reads the `.env` here.

```bash
node ../osrs-dev-stack/stack.mjs up full     # hub + map + Home Assistant; `up hub` for the hub alone
node ../osrs-dev-stack/stack.mjs smoke       # does what the plugin sends arrive at every hop
node ../osrs-dev-stack/stack.mjs chain auth  # one chain; without a name, all of them
node ../osrs-dev-stack/stack.mjs down
```

Before calling a change done, run the chain that follows what you changed:

| You changed | Run | What it proves |
| --- | --- | --- |
| Ingest, payload parsing, the plugin's protocol (`packages/core/src/payload`, `packages/server/src/ingest`, `/api/osrs-data/*`), the fixtures | `chain contract`, then `smoke` | Every payload fixture gets the answer the plugin expects, and the hub and Home Assistant say the same about one snapshot |
| `/api/v1` (`/snapshot`, `/events`, `/members`), API keys | `up full`, `smoke`, then look at the map | The map still gets positions, events and logins from this hub |
| Sharing, audiences, what a key may read | `chain privacy` | What an owner hides is gone for a service key, and nothing sent meanwhile reaches the map |
| Sign-in, the guild gate, membership, admin flags | `chain auth` | Who gets into the hub and, through `/members`, into the map |
| The location trail: what is stored of it, its times and its labels (`packages/core/src/ingest/plan.ts`, `packages/core/src/trail.ts`, `/locations`) | `chain delivery` and `chain trail`, then `smoke` | A walk whose messages came late, combined, out of order or twice is stored once and is the same walk on the map, and the label of every step of a journey reaches the map |
| Presence, sessions, timeouts | `chain presence` | A client that stops without a logout goes offline on hub, map and Home Assistant |
| Pairing, devices, tokens | `chain revoke` | A revoked device gets 401, which is what turns the plugin's connection off |

- A `FAIL` is yours to explain before you go on: either the change broke something downstream, or the
  chain needs to change with it (`../osrs-dev-stack/lib/chains.mjs`). A `KNOWN` line is a gap that is
  already written down in the stack's README; don't fix it in passing.
- To look at it: http://localhost:3200, "Sign in with Discord", pick Mock Admin (no password). The
  map is on :4100 and Home Assistant on :8124.
- Code reloads on its own (`next dev`). What is only read at start (configuration, the auth
  instance) needs `node ../osrs-dev-stack/stack.mjs restart hub`.
- Next allows one `next dev` per checkout: the stack's hub and your own `pnpm dev` can't run at once.
- When no chain covers what you changed and it reaches another component, add a step there rather
  than checking by hand once.
