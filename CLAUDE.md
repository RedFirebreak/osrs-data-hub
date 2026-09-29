## Self documenting

Update documentation in the `docs/` folder while making changes to the project. Use the following structure:

- `docs/ARCHITECTURE.md`: Use this file for architectural decisions, high level design and design of the project.
- `docs/CHANGELOG.md`: Keep track of changes to the project, consolidating entries into PR's.

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
