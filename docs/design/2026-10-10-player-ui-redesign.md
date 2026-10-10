# Player-focused hub UI: design

Status: approved by Red on 2026-10-10 and built (decisions D-112 to D-114 in ARCHITECTURE.md, which
is the reference from here on; this file is the design as it was agreed). The clickable prototype it
was settled with is not kept.

## Why

The hub's UI was built to show that data arrives: a dashboard of cards, an account page that lists
every section the plugin sends, and navigation that gives Devices, API keys and Settings the same
weight as the game data. Metrics (§15 of ARCHITECTURE.md) then added a deep, filter-driven view as a
tab under each account.

The people who open the hub are RuneScape players who now and then want to see a nice graph of
their progress. For them the current UI has three problems:

- History lives in two places. The account page has an XP chart, sessions and playtime; the Metrics
  tab has the same subjects again, in more depth.
- Metrics opens on its hardest view: a filter bar, six tiles and eight charts.
- The top bar spends most of its room on pages a player visits once.

## Decided with Red

| Question | Decision |
|---|---|
| Where progress lives | Its own top-level page with a character picker, not a tab under an account. |
| What the top bar holds | Home, Progress, Guild. Devices, API keys, Settings, Privacy and Admin move into the avatar menu. |
| What Home shows with one character | That character directly. A switcher appears only with two or more. |
| The look | "Clean": today's black and white. Colour comes only from the skills, in bars and charts. |
| The page's name | "Progress". (`/metrics` is the Prometheus endpoint, D-84.) |
| Where the detailed charts live | Their own "Deep dive" page linked from Progress. |
| The ranges | 1D, 7D, 30D, 90D, 1Y, plus "All" on a skill page. "1D" is the last 24 hours. |

## The flow

```
Home (your character, now)
  └─ pick a skill ──────────────► Skill page (that skill's graph, in its colour)
  └─ "See progress" ────────────► Progress (everything, one headline and one chart)
                                     ├─ pick a skill ───► Skill page
                                     ├─ pick a boss ────► Boss page
                                     └─ "Deep dive" ────► Deep dive (today's Metrics, unchanged)
Guild
  └─ pick a member's character ─► Character page (same layout as Home)
```

One rule sorts every piece of data: **the character page shows what is true now, Progress shows
what changed over time.** Nothing appears in both.

## Pages and addresses

| Address | Page |
|---|---|
| `/` | Home: the viewer's most recently played character, in the character layout, plus "Guild online now". Without characters, the existing "Connect RuneLite" empty state. |
| `/accounts/[publicId]` | The character page of any account the viewer may see. Same layout as Home. |
| `/progress` | Sends the viewer to `/progress/[publicId]` of their most recently played character. |
| `/progress/[publicId]` | Progress: the summary. `?range=` and `?measure=` in the address. |
| `/progress/[publicId]/skills/[skill]` | One skill. `?range=`. |
| `/progress/[publicId]/bosses/[activity]` | One boss (today's boss page, moved). |
| `/progress/[publicId]/deep-dive` | Today's Metrics page, moved as it is, with its filters in the address. |
| `/guild`, `/devices`, `/api-keys`, `/settings`, `/privacy`, `/admin/*` | Unchanged in content. |

The old addresses (`/accounts/[publicId]/metrics` and the boss pages under it) redirect to the new
ones and keep their query, so a bookmarked or shared view still opens.

### The top bar

Hub mark and name, then **Home, Progress, Guild**, then the live indicator and the avatar. Three
items fit at phone width, so the separate phone menu goes away. "Home" is marked current on `/` and
on the viewer's own characters; "Guild" on `/guild` and on other members' characters.

The avatar menu: Devices, API keys, Settings, Privacy; Admin (admins only); the theme; Sign out.
"Add device" moves from the dashboard header to the Devices page and stays in the empty state.

### The character page (Home)

In reading order:

1. **Header.** Name, account type, presence (online, world, where), total level. For someone else's
   character also the owner and previous names, as today. With two or more own characters, a
   switcher.
2. **Skills**, the main element of the page: the game's skills panel, three columns in the game's
   order. Each tile shows the icon, name, level, a thin bar for the way to the next level in the
   skill's colour, and the XP gained in the last 7 days when there is any. A tile opens that
   skill's page. At phone width a tile keeps icon, level and bar.
3. **This week.** XP gained in 7 days with a small line, levels gained, time played, loot, and the
   four most trained skills. "See progress" opens Progress.
4. **Latest.** The events timeline as it is today (type filters, load more, live). A level-up opens
   its skill's page.
5. **Right now.** Location, hitpoints, prayer and spellbook in one card (today's Vitals and
   Location).
6. **Worn** and **Inventory.** The grids as today. The gear change log stays, folded, under Worn.
7. **Hiscores.** The official ranks as today; a boss opens its boss page.
8. **Guild online now** (Home only) and **Sharing** (owner, contributors and admins), as today.

Leaving the character page: the skills table's gain columns, the XP history chart, "Sessions &
playtime", the Wealth chart and the Overview | Metrics tabs. Where they go:

| Today on the account page | New home |
|---|---|
| Skills table: gains today / 7 / 30 / 365 days, virtual level | Skill page (and "What you trained" on Progress) |
| XP history chart | Skill page |
| Sessions & playtime | Progress, measure "Time played"; the session list on Deep dive |
| Wealth per day | Deep dive |

### Progress

- **Header:** "Progress", the character picker (own characters; arriving from a guild member's page
  shows theirs).
- **One card with the answer:** a headline ("+1,265,900 XP in the last 7 days"), the range control
  (1D, 7D, 30D, 90D, 1Y) in the card's corner next to what it changes, and one chart that adds up
  through the range. Four pills choose what is counted: XP, Loot, Boss kills, Time played.
- **What you trained:** the skills that gained XP in the range, most first, each with a bar in its
  colour, the XP gained and the level. A row opens the skill's page.
- **Bosses:** kills gained in the range and the total. A row opens the boss page.
- **Goals:** as today.
- **Deep dive:** one line that says what is behind it (sessions, effective hours, rates, filters)
  and opens the Deep dive page with the same character and range.

### The skill page

- A strip of all skill icons to move sideways between skills, and "All skills" back to Progress.
- Icon, name, level (the virtual level beside it past 99, D-44), total XP, and the bar to the next
  level with "62% of the way to 88" and the XP to go.
- The headline and chart in the skill's colour, with the range control. This page also offers
  "All", since the hub keeps daily XP forever.
- Four facts: XP an hour while training, play time to the next level at this pace, levels gained,
  time spent training.
- Milestones (the level-ups in the range) and the skill's goal, or the way to set one.

### Deep dive

Today's Metrics page moved to its new address: filter bar, totals, comparison, heatmap, scatter,
rate through a session, where the time goes, sessions, skills, bosses. It gains the Wealth chart.
No panel is redesigned in this work.

## The look

"Clean" keeps the hub's neutral tokens (`globals.css`) and Geist. What changes:

- **Skill colours.** One table of 24 skills with a light-theme and a dark-theme colour each
  (`apps/web/src/lib/skill-colors.ts`), every value at least 4.5:1 against the card background of
  its theme, checked by a unit test. Used for bars, chart lines and areas, the gain number on a
  tile and the headline of a skill page. Everything else stays in the text colours.
- **Other measures.** Loot, boss kills and time played take the first three colours of the existing
  chart palette, the same on every page.
- **The Metrics accent goes.** `--metrics-accent` (amber) is removed; Deep dive uses the neutral
  theme like the rest.
- **Type.** Page titles and headline numbers get a display size with tight leading and negative
  tracking; body text stays as it is; every number that changes or lines up is tabular.

## How it should feel

Taken from the apple-design notes Red supplied, applied where they fit a data site:

- **Respond on press.** Tiles, rows, pills and the range control react on pointer-down (a 0.97
  scale), not on release.
- **The chart bends, it doesn't redraw.** Changing the range or the measure updates the existing
  chart from what is on screen; a second change mid-way redirects it. The headline number counts
  with it. ECharts animates a data update on a chart instance it keeps; today's wrapper replaces
  the whole option on every change (`notMerge` in `components/charts/echart.tsx`), so the Progress
  chart gets an update path that keeps its series (`morph`, D-114). No animation library is added.
- **Controls sit next to what they change**: the range control inside the chart's card, the picker
  beside the page title.
- **Menus open from their trigger** (Radix already sets the origin).
- **The common path first, the advanced one a level deeper**: Progress before Deep dive.
- **Wayfinding.** Every page says where you are (title, current nav item) and how to get back
  ("All skills", the top bar).
- `prefers-reduced-motion` turns the movement into a plain swap; `prefers-reduced-transparency`
  makes the top bar solid.

## What stays the same underneath

- **No new data and no new tables.** Progress and the skill page read the existing
  `getAccountMetrics` (totals, the cumulative comparison, skills, bosses, goals) and the XP route;
  Home reads `getAccountPage` plus the 7-day numbers. If the summary proves slow because the read
  model also computes the Deep dive panels, it gets an option to skip them.
- **The address is the view** (D-106): range and measure live in the query, so a view can be
  bookmarked or sent.
- **Sharing and access rules** carry over unchanged: a panel the viewer may not read isn't
  rendered, "Not shared" where the plugin never sent it (D-4), day-only stamps without `activity`
  (D-50), the same 404 for unknown and hidden accounts before anything streams (NEXT-14), boss
  pages need `hiscores`.
- **The chart rules** of §12 and §15 hold: one y-axis, "Show as table" under every chart, time left
  to right.
- The public API, the plugin protocol and the worker are not touched.

## Checking it

- `pnpm test`: the page tests move with their pages; new tests for the skill colour contrast, the
  Progress and skill pages' access rules, the redirects and the navigation.
- `pnpm test:e2e` with `E2E_SCREENSHOTS=1` for a visual pass of every page in both themes and at
  phone width.
- The dev stack's `smoke`, since the hub is one checkout for everything that reads it. No chain
  follows a page layout, and none needs to change.

## Build order

Each step leaves the hub working and is one commit.

1. The top bar and avatar menu.
2. Skill colours, the skills panel, the character page, Home as the character.
3. Progress with its picker and range control; Deep dive at its new address; the redirects.
4. The skill page; the boss page at its new address.
5. Motion, phone width, both themes, ARCHITECTURE.md (§12, §15 and the decision log), and removing
   the prototype.

## Not in this work

Redesigning the Deep dive panels or the Guild, Devices, API keys, Settings and Admin pages beyond
what the shared tokens change; new measures; comparing characters; a game-styled skin.

## What changed while building

- "Sessions & playtime" moved to Deep dive whole (the playtime chart and the recent sessions with
  their worlds), instead of being split between a Progress measure and Deep dive's session list.
- The fourth pill is "Play time": the time with XP or drops (Deep dive's active time), with the time
  online beside it.
- The skill colours pass 4.5:1 on the muted tile surfaces too, not only on the card.
- "Add device" is on the Devices page only.
