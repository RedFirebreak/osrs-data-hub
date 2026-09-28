# Gotchas

0 traps, grouped into zero files, found while building <!-- FILL: project name -->. Each is written up
once under a stable ID and referenced by ID from everywhere else, so there is exactly one place to edit
when something changes. <!-- FILL: one sentence naming the shared layer the traps are true of, e.g.
"Plugin-agnostic: things that are true of the client or the API and will bite the next plugin as well as
this one." -->

**Where a fact goes.** This is the one statement of the routing rule; skills and CLAUDE.md cite it.

| The behaviour is… | Goes in |
|---|---|
| True of <!-- FILL: the shared layer (framework, API, platform, toolchain) -->, and will bite the next <!-- FILL: unit, e.g. plugin / service / module --> | a numbered entry here |
| True of one <!-- FILL: unit --> only | <!-- FILL: that unit's own doc, e.g. its `ARCHITECTURE.md` § "Expect these" --> |
| Read in the docs but never seen live | [open-questions.md](open-questions.md), no ID, not indexed |
| Something that simply works, confirmed live | <!-- FILL: where confirmations go, e.g. that unit's `RUNS.md`, dated --> |

**How to use the index.** Match the symptom in the table at the bottom, then open the one file that entry
points to. The symptom column is deliberately specific enough to rule an entry out without opening anything.
Do not read this directory wholesale: the index is the discovery mechanism, and loading every area file
defeats the point of them being separate.

| File | Covers | Entries |
|---|---|---|
| [open-questions.md](open-questions.md) | read from docs, not yet observed — no IDs, not in the index | — |

**Source key.** Every entry ends with the source it was settled from:
`` `DOCS` `` = official documentation, `` `SOURCE` `` = read off the source code or shipped binary,
`` `OBSERVED` `` = seen live, which says where and on what date. An entry without `` `OBSERVED` `` is read
from docs and not yet confirmed in practice. <!-- FILL: keep, rename or add keys for this project, then
delete this marker -->

**Adding one.** IDs are permanent: a new entry takes the next free number in its prefix, and nothing is
ever renumbered. Put it in the area file in ID order, add its row to that file's table and one row to the
index below under its file's group, with the symptom text identical in both, and correct the count in the
first sentence of this file and in the file table. Then `python tools/check_gotchas.py` must print `OK`.
The `gotcha` skill walks this, including a trap that fits no existing file.

## Index

| ID | Area | Symptom |
|---|---|---|

## Retired IDs

Not traps, and never to be cited: these numbers were merged into the entry named, or moved out, and
`tools/check_gotchas.py` fails any mention of them outside this table. The table exists so a citation in
git history or an old chat can still be resolved. A retired number is never reused.

| Retired | Now |
|---|---|
