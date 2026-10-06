# HA Exporter plugin protocol

The HA Exporter v1.5 wire protocol as seen from the hub (payload shapes, Gson serialization, the OkHttp transport, status handling, the retry queue, the pairing panel).

Plugin paths are relative to `src/main/java/haexporterplugin/` in
`xXD4rkDragonXx/runelite-homeassistant-data-exporter@0ec2a36` (v1.5); RuneLite paths are from
`client-1.13.0` / `runelite-api-1.13.0` sources.

| ID | Symptom |
|---|---|
| [PLUGIN-1](#plugin-1) | Ingest answers 400 to payloads sent at client start and right after login, or a player shows offline for a moment during loading screens and world hops. |
| [PLUGIN-2](#plugin-2) | A player's data silently stops arriving (no error on either side) and the access log shows a 3xx on `/api/osrs-data/*`, or a body-less `GET /api/osrs-data/events` carrying `X-Osrs-Token`. |
| [PLUGIN-3](#plugin-3) | After the hub answers one payload with a 5xx, that player's events from the next ~5.5 minutes never arrive and no snapshots arrive for ~15 minutes, while other players are fine. |
| [PLUGIN-4](#plugin-4) | The plugin pauses and later resends payloads the hub had already committed; the original requests took 10 s or longer. |
| [PLUGIN-5](#plugin-5) | The plugin ignores the hub's `Retry-After` and waits 30 s, 60 s, 120 s… instead. |
| [PLUGIN-6](#plugin-6) | Pairing rejects a code the player typed as five digits, or a code handled as a number loses its leading zero (`04817` → `4817`). |
| [PLUGIN-7](#plugin-7) | Searching stored raw payloads for `Kree'arra`, `d'hide` or `search=` finds nothing, and the raw bodies contain `\u0027`, `\u003d` or `\u0000`. |
| [PLUGIN-8](#plugin-8) | A normal-world account suddenly shows league (or other special-world) stats and inventory, with `SEASONAL` in its world types, although special-world sending is off. |
| [PLUGIN-9](#plugin-9) | Total level is higher than the game shows (2459 against the in-game 2372 in the fixtures), sometimes above 24 × 99. |
| [PLUGIN-10](#plugin-10) | Every payload from one player arrives twice, from two of their devices, with identical `eventId`s. |
| [PLUGIN-11](#plugin-11) | Carried wealth or item counts are off: five sharks arrive as five entries of `quantity: 1`, and inventory, kept and lost items don't add up the same way. |
| [PLUGIN-12](#plugin-12) | Deaths and superior spawns inside raids and other instances have coordinates nowhere near the player's live location in the same instance. |
| [PLUGIN-13](#plugin-13) | In the plugin's pairing panel, Submit does nothing: no dialog, no request reaches the hub, and the button stays disabled. |
| [PLUGIN-14](#plugin-14) | One player's location trail holds a stretch twice, the same tiles again some seconds later, although it was walked once; or the stretch walked during an outage lies some seconds late in the trail, interleaved with what was walked after it. |

### PLUGIN-1
**Ingest answers 400 to payloads sent at client start and right after login, or a player shows offline for a moment during loading screens and world hops.**
The plugin legitimately sends payloads with no `player` or a partial one. At client start and on every
return to LOGIN_SCREEN it sends `{"events":[{"type":"clientShutdown","data":"Logout",…}],"state":"LOGIN_SCREEN","tickDelay":0,…}`
with no player (the root is reset, HAExporterPlugin.java:132-137); "Disabled" on the login screen has no
player and no `state`. After a login or hop, HP/prayer `StatChanged` sends before the first GameTick carry
a `player` with only `health` (then `prayerPoints`), no `name` or `accountHash`, and `tickDelay: 0`
(:142-159). `state` is absent after a reset and can be `LOADING`, `HOPPING` or `CONNECTION_LOST` when a
send lands in those states. Fix: every `player.*` key is optional (packages/core/src/payload/types.ts); a
payload with neither name nor hash and no events is answered 200 and ignored; presence counts
`LOGGED_IN`, `LOADING`, `HOPPING` and `CONNECTION_LOST` as in game (`IN_GAME_STATES`,
packages/core/src/presence.ts); `tickDelay: 0` means unknown.

*Source: `SOURCE` (HAExporterPlugin.java:91-159, Root.java:14-32 @0ec2a36); runtime ordering not yet seen from a live client*

### PLUGIN-2
**A player's data silently stops arriving (no error on either side) and the access log shows a 3xx on `/api/osrs-data/*`, or a body-less `GET /api/osrs-data/events` carrying `X-Osrs-Token`.**
RuneLite's OkHttp 3.14.9 follows redirects: a 301/302/303 on the POST becomes a GET with no body that
still sends `X-Osrs-Token` (in clear text on an http hop), and 307/308 on a POST are not followed at all.
The plugin classifies the resulting 3xx, 404 or 405 as REJECTED (ConnectionBackoff.java:64-81): the
payload is dropped, with no pause, no retry and nothing shown to the player, for every payload from then
on. Typical triggers: the player typed `http://` and the proxy upgrades to https, a www/apex redirect, or
Next's `trailingSlash: true` (`POST /api/osrs-data/events/` → 308). `trailingSlash: false` doesn't remove
Next's own redirect either: it answers `POST /api/osrs-data/events/` with a 308 to the slash-less path.
The plugin never sends that itself (it strips the base URL's trailing `/` and appends fixed paths), so only
a hand-built URL hits it; `skipTrailingSlashRedirect: true` would switch the redirect off (docs, not tried).
Fix: never redirect `/api/osrs-data/*` at the proxy (docs/OPERATIONS.md §3); `trailingSlash: false`
(apps/web/next.config.ts); answer GET on the plugin routes with a JSON `400 {"error":"…"}` naming the exact
https:// URL (the pairing dialog shows that text), and count token-bearing GETs per device as a
misconfigured URL (apps/web logs them with the device id).

*Source: `OBSERVED` (research sandbox: OkHttp 3.14.9 against a capture server, `fixtures/redirect-301-downgraded-get.http`; Next 16.3.6 standalone, 2026-09-28; the 308 with `trailingSlash: false`, apps/web standalone, 2026-09-29); `SOURCE` (ConnectionBackoff.java:64-81 @0ec2a36)*

### PLUGIN-3
**After the hub answers one payload with a 5xx, that player's events from the next ~5.5 minutes never arrive and no snapshots arrive for ~15 minutes, while other players are fine.**
On a 5xx the plugin backs off exponentially (30, 60, 120, 240, 480 s; ConnectionBackoff.java:146-157)
and queues payloads that carry events. A failed resend stays at the head of the queue (:206-217,
HomeAssistUtils.java:320-334), so a payload that fails every time is retried at t ≈ 30, 90, 210 and 450 s
and blocks everything behind it. At t ≈ 930 s it is pruned (10 min after enqueue, :227-232) together with
every event queued before t ≈ 330 s; snapshot-only payloads are dropped during the whole pause. Fix: 5xx
only for transient faults (`isTransientDbError` → 503 + `Retry-After`); anything the payload itself
causes (SQLSTATE class 22 or 23 other than a racing 23505, a jsonb reject, a parser bug) is answered 400,
so the plugin drops just that payload (`isDataDbError`, packages/db/src/errors.ts). See
([DB-1](database.md#db-1)), ([DB-9](database.md#db-9)).

*Source: `SOURCE` (ConnectionBackoff.java:146-157,206-232, HomeAssistUtils.java:320-334 @0ec2a36)*

### PLUGIN-4
**The plugin pauses and later resends payloads the hub had already committed; the original requests took 10 s or longer.**
RuneLite's shared OkHttp client sets no timeouts (RuneLite.java:416-440), so OkHttp's defaults apply:
connect, read and write 10 s each. A response slower than that is an `onFailure` in the plugin, handled
like a 5xx: a 30 s+ pause, snapshots dropped, event payloads queued and later resent byte-identical, while
the hub may already have committed the first attempt. Fix: keep every request well under 10 s. The pool
gives up connecting after 5 s (`connectionTimeoutMillis`, packages/db/src/client.ts), the per-account
advisory lock waits under a transaction-local `lock_timeout` (55P03 → 503), and an early
`503 Retry-After` beats a slow 200. Resends are absorbed by the unique event key
([DB-2](database.md#db-2)).

*Source: `SOURCE` (RuneLite client 1.13.0 RuneLite.java:416-440); `OBSERVED` (research sandbox, OkHttp 3.14.9 default timeouts, 2026-09-28)*

### PLUGIN-5
**The plugin ignores the hub's `Retry-After` and waits 30 s, 60 s, 120 s… instead.**
`parseRetryAfter` (ConnectionBackoff.java:88-107) accepts only digits after trimming (`0` becomes the 1 s
floor) or an RFC 1123 date with the correct weekday and `GMT` or a numeric offset, clamped to
[1 s, 10 min]. `3.5`, `-5`, `1e2`, a 20-digit overflow, `UTC` or `Z` zones, a wrong weekday, ISO-8601 and
RFC 850 are all rejected, and the plugin silently falls back to its exponential backoff. Fix: always send
integer delta-seconds ≥ 1 (`retryAfterSeconds` is a whole number, packages/core/src/ratelimit.ts); never
send a date.

*Source: `OBSERVED` (research sandbox: a verbatim copy of `parseRetryAfter` run against each value, 2026-09-28); `SOURCE` (ConnectionBackoff.java:88-107 @0ec2a36)*

### PLUGIN-6
**Pairing rejects a code the player typed as five digits, or a code handled as a number loses its leading zero (`04817` → `4817`).**
The panel's code field accepts `Character.isDigit`, which is true for any Unicode digit (Arabic-Indic
`٣`, U+0663, for one); pasting strips only ASCII non-digits and keeps the first five
(HAExporterPanel.java:615-685). The request body is `{"code":"04817"}`: a JSON string, always five
characters when Submit is enabled, leading zeros kept. Fix: accept only a string matching `^[0-9]{5}$`
and never convert it to a number (`isValidPairingCode`, packages/core/src/crypto.ts); a JSON number is
rejected.

*Source: `SOURCE` (HAExporterPanel.java:40,615-685 @0ec2a36); `OBSERVED` (research sandbox: `Character.isDigit(U+0663)` is true, 2026-09-28)*

### PLUGIN-7
**Searching stored raw payloads for `Kree'arra`, `d'hide` or `search=` finds nothing, and the raw bodies contain `\u0027`, `\u003d` or `\u0000`.**
The plugin serializes with RuneLite's Gson 2.8.5, which has HTML escaping on (no `disableHtmlEscaping`):
`'` `=` `&` `<` `>` are written as `\u0027` `\u003d` `\u0026` `\u003c` `\u003e`, and every control
character other than `\t \b \n \r \f` as `\u00XX`, including `\u0000` (JsonWriter.java:138-161). JSON
parsers decode all of it; byte matching and grep don't. Doubles below 1e-3 use exponent notation
(`2.0E-4`). Fix: search raw bodies for the escaped form, or parse first; compare fixtures after parsing.
The NUL escape also breaks jsonb ([DB-1](database.md#db-1)): raw bodies are stored as text and NUL is
stripped before any jsonb write (`stripNul`, packages/core/src/json.ts).

*Source: `OBSERVED` (research sandbox: `Probe.java` on Gson 2.8.5, 2026-09-28); `SOURCE` (gson-2.8.5 JsonWriter.java:138-161)*

### PLUGIN-8
**A normal-world account suddenly shows league (or other special-world) stats and inventory, with `SEASONAL` in its world types, although special-world sending is off.**
HOPPING doesn't reset the plugin's payload root (HAExporterPlugin.java:128-131), and the special-world
drop checks the *live* world type, not the payload's (TickUtils.java:59-65). After hopping off a special
world, the HP/prayer sends before the first GameTick carry the stale snapshot: the previous world,
`worldTypes` including `SEASONAL`, league stats and inventory. The `accountHash` is the same on special
worlds (RuneLite keys profiles by account hash plus profile type, ConfigManager.java:953), so these
payloads, and opted-in special-world data, land on the main account. Fix: decide from the payload's own
`worldTypes` (`isSpecialWorld`, packages/core/src/worlds.ts) and update only live fields for them; the
XP-drop guard (D-24) is the backstop.

*Source: `SOURCE` (HAExporterPlugin.java:128-131, TickUtils.java:59-65 @0ec2a36; RuneLite 1.13.0 ConfigManager.java:953,1506); runtime ordering not yet seen live*

### PLUGIN-9
**Total level is higher than the game shows (2459 against the in-game 2372 in the fixtures), sometimes above 24 × 99.**
`stats.skills[*].level` is the real level below 99, but at 99+ it is the virtual level from XP (up to
126, and 127 at 200M XP; LevelNotifier.java:34-60). There is no `Overall` entry, so a total summed from the
payload is inflated for every skill past 99. Fix: total level = Σ min(level, 99) (`totalLevel` and
`MAX_REAL_LEVEL`, packages/core/src/skills.ts); store that real total for the derived Overall row, never
the virtual sum.

*Source: `SOURCE` (LevelNotifier.java:34-60 @0ec2a36; a script over the research fixtures gives 2459 against 2372)*

### PLUGIN-10
**Every payload from one player arrives twice, from two of their devices, with identical `eventId`s.**
Pairing never reuses a connection: pairing again with the same hub adds a second connection with its
own token (ConfigUtils.java:39-61), and the plugin sends the same serialized payload to every enabled
connection (HomeAssistUtils.java:81-115). Per-device rate limits, "last seen" and payload counters see
double traffic. Fix: deduplicate per account and `eventId` only, never per device (D-16, the unique
event key of [DB-2](database.md#db-2)); nothing keyed by (device, eventId).

*Source: `SOURCE` (ConfigUtils.java:39-61, HomeAssistUtils.java:81-115 @0ec2a36)*

### PLUGIN-11
**Carried wealth or item counts are off: five sharks arrive as five entries of `quantity: 1`, and inventory, kept and lost items don't add up the same way.**
`inventory.items` and death `keptItems` have one entry per occupied slot; only stackables carry a
quantity above 1 (ItemUtils.java:46-61). Loot `items` and death `lostItems` are merged by item id, and
`equipment.items` is one entry per slot with `equipmentSlot`. `gePrice` (long) and `haPrice` (int) are
per unit. Fix: always sum `gePrice × quantity` over entries; never key inventory by item id (a map keeps
one shark of five); equipment can be keyed by `equipmentSlot`. From v1.5.1, `inventory.items` entries
also carry `inventorySlot` (0..27, left to right then top to bottom), but empty slots are still omitted
and kept/lost and loot items never have it (DeathNotifier clears it), so a position in the list is
never a slot: place by `inventorySlot` when present.

*Source: `SOURCE` (ItemUtils.java:46-89, DeathNotifier.java:146-194, LootNotifier.java:141-207 @0ec2a36; ItemUtils.java:50-62, DeathNotifier.java:148 @9835dbe, v1.5.1)*

### PLUGIN-12
**Deaths and superior spawns inside raids and other instances have coordinates nowhere near the player's live location in the same instance.**
The snapshot `player.location` goes through `WorldPoint.fromLocalInstance`, giving template (real-world)
coordinates (LocationNotifier.java:25-28), and on a boat it is the boat's position. `death.location`
(`getLocalPlayer().getWorldLocation()`, DeathNotifier.java:175) and `superiorSpawn.location`
(`npc.getWorldLocation()`, SuperiorNotifier.java:37-51) are raw instance coordinates. Fix: treat event
locations as a different coordinate space from snapshot locations: don't join them, and don't plot them
on the world map as if they were comparable. The points of plugin 1.6's `player.locationTrail` are made
from the same `WorldPoint` as `player.location`, so they share its space; inside an instance built from
copied rooms (a player-owned house) neighbouring rooms can then be far apart, and a walk through a
doorway looks like a jump (D-102).

*Source: `SOURCE` (LocationNotifier.java:13-31, DeathNotifier.java:175, SuperiorNotifier.java:37-51 @0ec2a36; LocationNotifier.java:36-58 @2a5b33a, v1.6.0); the house doorway `OBSERVED` by the plugin's authors in a live client (plugin PR 42, 2026-10-02)*

### PLUGIN-13
**In the plugin's pairing panel, Submit does nothing: no dialog, no request reaches the hub, and the button stays disabled.**
The endpoint URL was entered without a scheme (`hub.example.com`, `hub.example.com:443`) or with a
non-http one. OkHttp's `Request.Builder.url()` throws `IllegalArgumentException: Expected URL scheme
'http' or 'https' …` synchronously on the Swing thread inside the Submit handler, after the button was
disabled (HAExporterPanel.java:570-581,741-743); nothing catches it, so no dialog appears and Submit stays
disabled until a field is edited. Fix: the wizard shows the full URL including `https://` with a copy
button, and the troubleshooting text tells players to paste it exactly.

*Source: `OBSERVED` (research sandbox: OkHttp 3.14.9 `Request.Builder.url` on scheme-less input, 2026-09-28); `SOURCE` (HAExporterPanel.java:570-581,741-743 @0ec2a36)*

### PLUGIN-14
**One player's location trail holds a stretch twice, the same tiles again some seconds later, although it was walked once; or the stretch walked during an outage lies some seconds late in the trail, interleaved with what was walked after it.**
That player's PC clock runs more than 10 s ahead. The hub knows a trail point it already has only by its
time: points are inserted with `ON CONFLICT DO NOTHING` on `(account_id, ts)` (`writeDerived`,
packages/server/src/ingest/store.ts). And a message keeps the plugin's per-point times only when its own
time is plausible on arrival, within [receive time − 15 min, receive time + 10 s] (`isPlausibleClock`,
packages/core/src/time.ts); any other message is re-dated as a whole so that it ends at the receive time
(`planTrail`, packages/core/src/ingest/plan.ts). With such a clock a message that arrives on time is
re-dated, while one that arrives late (sent again after a timeout, [PLUGIN-4](#plugin-4), or held in the
retry queue) can look plausible and is then stored as sent; with a clock so far ahead that the late one
is not plausible either, it is re-dated to its own, later receive time. So when the hub had already
stored the first copy of a resend, the second gets different times and both stay.

Seen with a clock 30 s ahead: three tiles (x 3300 to 3302, y 3320) walked once were stored at
05:33:52.2Z to 05:33:53.4Z (re-dated) and, from the unchanged resend 25.8 s later, again at 05:34:22.2Z to
05:34:23.4Z (as sent). `/locations` returned them twice, 30 s apart, all `move`, and the map drew them.
With a correct clock the same sequence stores every point once. Other faces of the same split:

- An outage interleaves: the messages delivered on time are re-dated to the true time, the queued ones
  arrive late and are stored 30 s ahead.
- A clock that is behind is taken as it is for longer. Up to 15 min behind, everything keeps the plugin's
  (shifted) times; only a message that also waited in the plugin's queue, so that lag plus wait exceeds
  15 min, is re-dated instead.
- Two connections on one PC ([PLUGIN-10](#plugin-10)) each get their copy on time, so each copy is
  re-dated to its own receive time and every point is stored twice, milliseconds apart (worked out with
  `planTrail`, not seen live).

It takes a resend or a late delivery of a message with trail points. Up to plugin 1.6.1 that is only the
points riding in a queued event payload. Plugin PR 45 ("Keep location trail points until they are
delivered", unmerged on 2026-10-06) queues and resends every message with trail points, and its README
tells receivers to de-duplicate on `timestamp`. Fix: none in the hub. The owner left it as it is on
2026-10-06 (D-102), so the PC clock has to be right. Considered and not done: remembering a clock offset
per device once a message proves the clock is ahead; having the plugin send its clock at send time;
storing the plugin's own time per point and de-duplicating on that.

When testing this, wait before reading: a point dated a few seconds ahead of the hub's clock is returned
by `/locations` only once that time has passed (the default `to` is now), so a read right after the
resend still shows the stretch once.

*Source: `OBSERVED` (dev stack, a sender with its clock 30 s ahead, 2026-10-06); `SOURCE` (`isPlausibleClock`, `planTrail` and `writeDerived` in this repository; plugin PR 45: README "Location trail" and "Delivery & Backoff", HomeAssistUtils.java:81-126,186-200,394-419 @a7b1f3c)*
