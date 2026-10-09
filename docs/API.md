# osrs-data-hub API v1

A read-only JSON API over the OSRS account data that guild members' HA Exporter RuneLite plugins send to
the hub. It is **pull-only**: poll `/snapshot` and the `/events` cursor feed; there are no webhooks (D-3).

- Base URL: `https://<your hub>/api/v1`
- Interactive reference: `https://<your hub>/docs/api`
- OpenAPI 3.1 document: `https://<your hub>/api/v1/openapi.json` (public, no key needed)
- Static copy: [openapi.json](openapi.json), built with `APP_URL=https://hub.example.com`. The project
  website renders it as its API reference. A test fails when it is stale; refresh it with
  `pnpm openapi:update`.

Design decisions: D-69 … D-77, D-88 … D-94, D-98 and D-100 in [ARCHITECTURE.md](ARCHITECTURE.md).

## Authentication

1. Sign in to the hub and open **API keys** (`/api-keys`). Create a key and choose:
   - a **name**;
   - the **categories** it may read (below);
   - its **accounts**: every account you can see, now and later, or only accounts you pick;
   - an **expiry**: never, 30, 90 or 365 days.

   You can hold at most 10 active keys.
2. The key, `ohub_<prefix>_<secret>`, is shown **once**. The hub keeps only a hash. If you lose it,
   revoke it and create a new one.
3. Send it on every request:

       curl -H "Authorization: Bearer ohub_NM5kHo1WTn_…" https://hub.example.com/api/v1/me

What a key can read is worked out **on every request**: its categories ∩ its accounts ∩ what you, its
creator, can see right now under the owners' sharing settings. When someone stops sharing with you, your
keys stop seeing it immediately. Admin rights never apply through the API. Cookies are ignored.

These all get the same `401 unauthorized` (with `WWW-Authenticate: Bearer`): a missing, malformed,
unknown, revoked or expired key, or a key whose creator left the guild.

### Service keys (integration keys)

For the guild's own services (its live map, a shared bot) an admin creates a **service key** on
**Admin → Integrations** (`/admin/integrations`). Same format, categories and expiry as a user key, but
(D-88):

- it belongs to **no user**: offboarding anyone, the admin who created it included, never revokes it,
  and it counts towards nobody's limit of 10 keys;
- it reads what the **guild audience** sees (D-89): the accounts and categories whose sharing audience is
  *guild*. Accounts and categories set to *private* or *selected* stay hidden, exactly as for a member
  who is neither owner, contributor nor grantee, and so does an account its owner hid from the guild
  (D-104), which is left out whole as if it didn't exist. There is no admin override;
- its rate limit is its own: **600 requests per minute** unless the admin set another (1–6000);
  `/snapshot` stays at 1 per second;
- it alone sees `account_hash` (D-91), and it may name 50 accounts per bulk request instead of 10 (D-92);
- it alone can ask [`/members/{discord_id}`](#get-membersdiscord_id) whether a Discord account is a
  member of the hub and an admin (D-100). For a user key that endpoint doesn't exist;
- day-based periods (`period=day` on gains and leaderboards) use UTC, since it has no creator settings.

`/me` tells the kinds apart: `key.kind` is `user` or `service`, and `user` is `null` for a service key.

| Category | Covers |
|---|---|
| `stats` | skills, XP history, gains, levels |
| `events` | loot, level-ups, deaths, collection log, diaries, combat tasks, superiors |
| `activity` | online status, world, sessions and playtime, HP, prayer, spellbook |
| `location_live` | current coordinates (for the live map) |
| `location_history` | the 30-day trail |
| `equipment` | current gear and its change log |
| `inventory` | current inventory and wealth history |

## Conventions

- **Success:** `{ "data": …, "meta": { "generated_at": "…", … } }`. Lists add `meta.count`.
- **Errors:** `{ "error": { "code": "…", "message": "…" } }`. A 400 adds `details: [{ path, message }]`.
- **Key names:** every key the hub defines is **snake_case** (D-77). Keys that are data pass through
  unchanged: skill names (`"Attack"`), equipment slots, item and account names, and an event's `data`
  object (the plugin's event, with the plugin's own camelCase keys).
- **Timestamps:** ISO-8601 UTC. **Ids:** opaque strings (account ids are 12 base62 characters; event ids
  are uuids).
- **Query parameters:**
  - lists are comma-separated (`skills=attack,defence`);
  - dates are ISO-8601 date-times with `Z` or an offset (`2026-09-29T10:00:00Z`);
  - booleans are `true`/`false`;
  - unknown parameters are ignored;
  - a repeated parameter keeps its last value.
- **Evolution:** v1 only changes additively. New fields and endpoints may appear, so ignore keys you
  don't know.
- **Not found vs not readable:** anything the key can't read answers **404 `not_found`** with exactly the
  body of an unknown id. An unknown account, one outside the key's accounts, and one whose category the
  key can't read all look the same.
- **Omitted vs not shared:** on `/accounts/{id}` and `/snapshot`, a section of a category the key can't
  read on that account is **left out**. A section the key may read but the player's plugin never sent is
  `{ "shared": false, "updated_at": null }` on `/accounts/{id}`, or `null` on `/snapshot`.
- **Stale locations:** a live location older than 2 minutes has `stale: true`.
- **Caching:** `Cache-Control: no-store` everywhere, except:
  - `/snapshot`: `private, no-cache` with a weak `ETag`; `If-None-Match` → `304`;
  - `/openapi.json`: `public, max-age=300`.

## Rate limits

| Limit | Value | On excess |
|---|---|---|
| Per key, all endpoints | 120 requests per sliding minute for a user key; 600 for a service key, or the limit its admin set (`/me` reports it) | `429 rate_limited` + `Retry-After` |
| Per key, `/snapshot` | 1 request per second | `429` + `Retry-After: 1` |
| Failed authentications per client IP | 30 per minute | every request from that IP gets `429` until the window passes |

Every authenticated response carries these headers:

- `X-RateLimit-Limit`: the key's requests per minute (120 for a user key);
- `X-RateLimit-Remaining`;
- `X-RateLimit-Reset`: seconds until the window frees a request (a delta, **not** a timestamp).

`Retry-After` is always a whole number of seconds. A `304` counts too. The limits are kept in the web
process's memory (D-5, D-72).

## CORS

Every response, errors included, carries:

- `Access-Control-Allow-Origin: *`;
- `Access-Control-Expose-Headers: ETag, Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset`.

`OPTIONS` answers the preflight with `204` and:

- `Access-Control-Allow-Methods: GET, OPTIONS`;
- `Access-Control-Allow-Headers: Authorization, If-None-Match, Content-Type`;
- `Access-Control-Max-Age: 600`.

There are no credentials: send the key in the `Authorization` header. Browser apps such as a live map
can call the API directly.

## Errors

| Status | `code` | When |
|---|---|---|
| 400 | `invalid_request` | a malformed or out-of-range parameter (`details` names it) |
| 401 | `unauthorized` | no valid key |
| 404 | `not_found` | unknown or unreadable account, or an unknown path (which `/members/{discord_id}` is for a user key) |
| 429 | `rate_limited` | over a limit; wait `Retry-After` seconds |
| 503 | `unavailable` | the hub is busy or its database is unreachable; retry after `Retry-After` |
| 500 | `internal_error` | a bug; nothing about it is revealed |

    {"error":{"code":"not_found","message":"Account not found."}}
    {"error":{"code":"invalid_request","message":"The request is invalid.","details":[{"path":"from","message":"must be an ISO-8601 date-time with Z or an offset"}]}}

## Endpoints

Examples are shortened with `…`.

### GET /me

The key (kind, name, prefix, categories, scope, rate limit, expiry), its creator (`null` for a service
key) and how many accounts it can see. Useful as a connection test.

    GET /api/v1/me

    {"data":{"key":{"id":"01a0ed84-1852-7784-9a43-157469f2bddc","kind":"user","name":"Home Assistant","prefix":"NM5kHo1WTn",
     "categories":["stats","events","activity","location_live"],"account_scope":"all_visible","rate_limit_per_minute":120,"expires_at":null},
     "user":{"name":"Owner"},"visible_accounts":2},"meta":{"generated_at":"2026-09-29T14:14:12.330Z"}}

    {"data":{"key":{"id":"…","kind":"service","name":"Guild live map","prefix":"…","categories":["activity","location_live"],
     "account_scope":"all_visible","rate_limit_per_minute":600,"expires_at":null},"user":null,"visible_accounts":14},"meta":{…}}

### Owner identity and `account_hash`

`/snapshot`, `/accounts` and `/accounts/{id}` carry, on every account:

- `owner`: `{ "name", "discord_id" }`, the account's owner as the hub's guild page shows them to every
  member, or `null` when the account has no active owner (D-90). Contributors are never exposed.
- `account_hash` (**service keys only**, omitted for user keys, D-91): the plugin's salted SHA-224
  `accountHash`, the value the plugin sends to any endpoint it is paired with. A service that players
  also pair with directly can match a hub account to the same player without relying on the name.

### GET /accounts?names=&ids=&online=

The visible accounts, sorted by name.

Parameters:

- `names`: comma-separated display names, case-insensitive (at most 100);
- `ids`: comma-separated account ids (at most 100);
- `online=true|false`.

With `names` and/or `ids`, only matching accounts are returned. `online`, `world` and `last_seen` are
`null` without `activity`, and such accounts never pass an `online` filter.

    GET /api/v1/accounts?online=true

    {"data":[{"id":"oC8RsqiTuyak","name":"Alpha Main","account_hash":"3f0c…","type":0,"type_label":"Normal",
     "owner":{"name":"Owner","discord_id":"100000000000000042"},"online":true,"world":302,
     "last_seen":"2026-09-29T14:13:42.046Z"}],"meta":{"generated_at":"…","count":1}}

(`account_hash` appears for a service key only.)

### GET /accounts/{id}

One account's current state, section by section:

| Section | Category |
|---|---|
| `presence`, `vitals` | `activity` |
| `skills` | `stats` |
| `location` | `location_live` |
| `equipment` | `equipment` |
| `inventory` | `inventory` |

Each section sent by the plugin carries `shared: true` and `updated_at`.

    GET /api/v1/accounts/oC8RsqiTuyak

    {"data":{"id":"oC8RsqiTuyak","name":"Alpha Main","type":0,"type_label":"Normal",
     "owner":{"name":"Owner","discord_id":"100000000000000042"},"first_seen":"2026-09-29T13:24:12.046Z",
     "categories":["stats","events","activity","location_live"],
     "presence":{"shared":true,"updated_at":"2026-09-29T14:13:42.046Z","online":true,"world":302,"special_world":false,
                 "game_state":"LOGGED_IN","last_seen":"2026-09-29T14:13:42.046Z"},
     "vitals":{"shared":true,"updated_at":"…","hp":{"current":99,"max":99},"prayer":{"current":99,"max":99},"spellbook":"lunar"},
     "skills":{"shared":true,"updated_at":"…","total_level":2372,"overall_xp":534951983,
               "skills":[{"skill":"Overall","level":2372,"real_level":2372,"xp":534951983},
                         {"skill":"Attack","level":108,"real_level":99,"xp":34517847},…]},
     "location":{"shared":true,"updated_at":"…","x":3164,"y":3487,"plane":0,"is_on_boat":false,"stale":false}},
     "meta":{"generated_at":"…"}}

A section the plugin never sent looks like `"inventory":{"shared":false,"updated_at":null}`. Without
`activity`, the `updated_at` of skills, equipment and inventory is cut to the UTC day (D-50).

`equipment` and `inventory` hold `items` and `value` (Σ `ge_price × quantity`). An item is
`{id, name, quantity, ge_price, ha_price, equipment_slot, inventory_slot}`, one entry per occupied slot
(five sharks are five entries). `equipment_slot` (`HEAD`, `WEAPON`, …) is set on equipment items.
`inventory_slot` is the inventory slot, 0–27, left to right and then top to bottom (row = slot / 4,
column = slot % 4), from plugin 1.5.1 on; it is `null` on equipment and in inventories sent by an
older plugin, whose items are in the order the plugin sent them (D-86).

    "inventory":{"shared":true,"updated_at":"…","value":1650900,
                 "items":[{"id":4151,"name":"Abyssal whip","quantity":1,"ge_price":1650000,"ha_price":72000,"equipment_slot":null,"inventory_slot":0},
                          {"id":385,"name":"Shark","quantity":1,"ge_price":900,"ha_price":60,"equipment_slot":null,"inventory_slot":27}]}

### GET /snapshot?since=

Every visible account in one response, built for polling every 2–10 s. Limited to 1 request per second
per key.

Each account has `id`, `name`, `type`, `type_label`, `owner` and `categories` (and `account_hash` for a
service key). The other fields depend on the key's categories on that account:

- `activity`: `online`, `world`, `special_world`, `game_state`, `last_seen`, `hp`, `prayer`,
  `spellbook`;
- `location_live`: `location` (with `stale` and `updated_at`);
- `stats`: `skills`;
- `equipment`: `equipment`;
- `inventory`: `inventory`.

A field is omitted without its category, and `null` when readable but never sent. `game_state` is the
last game state the plugin sent (`LOGGED_IN`, `LOGIN_SCREEN`, `HOPPING`, …), the same value as
`presence.game_state` on `/accounts/{id}` (D-94), except that it's `null` once an in-game state
timed out (`online` turned false without the plugin reporting a logout, e.g. a crashed client), so it
never says `LOGGED_IN` for an offline account.

    GET /api/v1/snapshot
    → 200, ETag: W/"iJSsXZ1wy4SjrMLJMHceEMf2oLc", Last-Modified: Tue, 29 Sep 2026 14:13:42 GMT

    {"data":[{"id":"oC8RsqiTuyak","name":"Alpha Main","type":0,"type_label":"Normal",
      "owner":{"name":"Owner","discord_id":"100000000000000042"},"categories":["stats","events","activity","location_live"],
      "online":true,"world":302,"special_world":false,"game_state":"LOGGED_IN","last_seen":"2026-09-29T14:13:42.046Z",
      "hp":{"current":99,"max":99},"prayer":{"current":99,"max":99},"spellbook":"lunar",
      "location":{"x":3164,"y":3487,"plane":0,"is_on_boat":false,"stale":false,"updated_at":"2026-09-29T14:13:42.046Z"},
      "skills":{"total_level":2372,"overall_xp":534951983,"skills":[…]}},
     {"id":"jHSfP5UICcQt","name":"Bravo Alt",…,"online":false,"location":null,…}],
     "meta":{"generated_at":"…","count":2,"last_modified":"2026-09-29T14:13:42.046Z"}}

    GET /api/v1/snapshot   (If-None-Match: W/"iJSsXZ1wy4SjrMLJMHceEMf2oLc")
    → 304 Not Modified (no body)

The `ETag` hashes the response itself (D-74), so it also changes when an account goes offline or a
location turns stale without new data arriving.

**Polling with `since`:** pass the previous `meta.last_modified` as `since` to get only the accounts that
changed after it.

- Accounts that changed up to 30 s before `since` are sent again; merge them by `id`.
- Accounts whose `activity` the key can't read are always sent.
- An account that leaves the key's reach simply stops appearing, so fetch without `since` now and then.

### GET /accounts/{id}/xp?skills=&from=&to=&resolution=

XP series of one account (`stats`).

Parameters:

- `skills`: case-insensitive, at most 30; default Overall;
- `from`/`to`: default the last 7 days;
- `resolution`: `auto|5m|1h|1d`, default `auto` (5m up to 7 days, 1h up to 90, 1d beyond, coarser above
  5000 points).

Points are `[bucket start, XP at the end of the bucket]`. XP only changes where a point is. The value in
effect at `from` is carried in as the first point.

    GET /api/v1/accounts/oC8RsqiTuyak/xp?skills=attack&resolution=1h

    {"data":{"account":{"id":"oC8RsqiTuyak","name":"Alpha Main"},"resolution":"1h",
     "from":"2026-09-22T14:14:12.370Z","to":"2026-09-29T14:14:12.370Z",
     "series":[{"skill":"Attack","points":[["2026-09-29T13:00:00.000Z",34512847],["2026-09-29T14:00:00.000Z",34517847]]}]},
     "meta":{"generated_at":"…"}}

### GET /xp?accounts=a,b&skills=&from=&to=&resolution=

The same series for several accounts, in request order: 1–10 accounts with a user key, 1–50 with a
service key (D-92). If any account isn't readable (`stats`), the whole request is a 404 naming it, as if
it didn't exist; more accounts than the key's cap is a 400.

    GET /api/v1/xp?accounts=oC8RsqiTuyak,jHSfP5UICcQt&skills=overall&resolution=1d

    {"data":{"resolution":"1d","from":"…","to":"…","accounts":[
      {"account":{"id":"oC8RsqiTuyak","name":"Alpha Main"},"resolution":"1d","from":"…","to":"…",
       "series":[{"skill":"Overall","points":[["2026-09-29T00:00:00.000Z",534951983]]}]},…]},"meta":{…}}

### GET /accounts/{id}/gains?period=day|week|month|year (or from=&to=)

XP gained per skill (`stats`): every skill the account has, Overall first, 0 when nothing was gained.

- `day`: since local midnight in the key creator's time zone;
- `week`/`month`/`year`: the last 7/30/365 days;
- default `day`.

Give either `period` or `from` (optionally with `to`), not both.

    GET /api/v1/accounts/oC8RsqiTuyak/gains?period=week

    {"data":{"account":{"id":"oC8RsqiTuyak","name":"Alpha Main"},"period":"week","from":"2026-09-22T14:14:12.421Z",
     "to":"2026-09-29T14:14:12.421Z","gains":[{"skill":"Overall","xp":5000},{"skill":"Attack","xp":5000},…]},"meta":{…}}

### GET /events?cursor=&types=&accounts=&min_value=&limit=&from=&to=

The cursor feed of events on accounts whose `events` category the key can read (see
[The events cursor](#the-events-cursor)). With `from` and/or `to` it reads a time range instead (see
[Events in a time range](#events-in-a-time-range)).

Parameters:

- `types`: `loot`, `pk_loot`, `death`, `level_up`, `collection_log`, `superior_spawn`,
  `achievement_diary`, `combat_task`, or an unknown plugin type as sent;
- `accounts`: up to 100 ids, each readable, else 404;
- `min_value`: `value_gp` ≥ this;
- `limit`: 1–500, default 100;
- `from`, `to`: read a time range instead of the feed; `to` defaults to now, `from` to 30 days before
  `to`.

`data` is the page of events, oldest first; `meta.next_cursor` is the cursor for the next call. Each
event's `data` is the plugin's event object, passed through unchanged (its shape depends on `type`).
`data.location` on deaths and superiors is removed unless the key reads `location_live` or
`location_history` on that account.

    GET /api/v1/events?cursor=djE6MA&types=loot&min_value=1000000

    {"data":[{"id":"01a0ed84-1827-7008-ad3e-ffb85a03171a","type":"loot","account":{"id":"oC8RsqiTuyak","name":"Alpha Main"},
      "occurred_at":"2026-09-29T14:13:40.046Z","received_at":"2026-09-29T14:13:42.046Z","value_gp":35237280,
      "item_id":11828,"npc_id":3162,"skill":null,"level":null,"tier":null,"points":null,"special_world":false,
      "data":{"type":"loot","eventId":"d57690f0-…","timestamp":1790691220046,
              "data":{"type":"NPC","npcId":3162,"totalValue":35237280,"items":[{"id":11828,"name":"Armadyl chestplate","gePrice":35236970,…},…],…}},
      "title":"Loot","line":"Alpha Main received Armadyl chestplate (35.2M) from Kree'arra"}],
     "meta":{"generated_at":"…","count":1,"next_cursor":"djE6MQ"}}

### GET /accounts/{id}/sessions?from=&to=

Play sessions overlapping the range, newest first (`activity`). Default: the last 30 days.

    {"data":{"account":{…},"from":"…","to":"…","sessions":[{"id":"01a0ed84-…","started_at":"2026-09-29T13:24:12.046Z",
     "ended_at":null,"last_seen_at":"2026-09-29T14:13:42.046Z","duration_ms":2970000,"worlds":[302],"end_reason":null}]},"meta":{…}}

`end_reason` is `logout`, `shutdown`, `disabled`, `timeout`, or `null` while the session is open.

### GET /accounts/{id}/equipment-history?from=&to=

Every change of the worn set, newest first, each with the whole set after it (`equipment`). Default: 30
days.

    {"data":{"account":{…},"from":"…","to":"…","changes":[{"changed_at":"2026-09-29T13:24:12.046Z",
     "items":[{"id":10828,"name":"Helm of Neitiznot","quantity":1,"ge_price":47601,"ha_price":30000,"equipment_slot":"HEAD","inventory_slot":null},…]}]},"meta":{…}}

### GET /accounts/{id}/wealth?from=&to=

Carried value (inventory + equipment at GE prices) per UTC day, oldest first (`inventory`). Default: 30
days.

    {"data":{"account":{…},"from":"…","to":"…","days":[{"day":"2026-09-29","last_value":84474944,"max_value":84474944}]},"meta":{…}}

### GET /accounts/{id}/locations?from=&to=

The location trail, oldest first (`location_history`, kept 30 days). Default: the last **24 hours**
(the other histories default to 30 days).

    {"data":{"account":{…},"from":"…","to":"…","truncated":false,"points":[
      {"at":"2026-09-29T13:24:25.236Z","x":3164,"y":3487,"plane":0,"world":302,"is_on_boat":false,"via":null},
      {"at":"2026-09-29T13:24:25.832Z","x":3166,"y":3489,"plane":0,"world":302,"is_on_boat":false,"via":"move"},…]},"meta":{…}}

- **What a point is.** With plugin 1.6 or newer: every tile the player was on, one point per game
  tick (0.6 s) on which the tile, plane or boat state changed, dated by the player's PC (D-102). With
  an older plugin, and while a player stands still: one point a minute.
- **`via`** says how the player got to a point from the one before it (D-103). Only `move` is a
  line to draw.

  | `via` | What happened |
  | --- | --- |
  | `move` | Walked, ran or sailed: the point is within reach of the one before. Stairs are a move to another `plane`. |
  | `entrance` | Into or out of the underground (a cave, a dungeon, a basement), which lies 6400 tiles north of the surface. The player went through an entrance at this spot. |
  | `house` | From one room of a player-owned house to the next. The player walked, but the coordinates are those of the map area each room was copied from, so they jump. |
  | `instance` | The same between two rooms of the Gauntlet, the Corrupted Gauntlet or the Chambers of Xeric, which the game also builds from copied rooms. |
  | `teleport` | Anything else that wasn't walked: a teleport, including into or out of the house or an instance. |
  | `gap` | More than 5 minutes since the point before: offline, not sharing, or a stretch that never reached the hub. Nothing is known about what happened in between. |
  | `null` | The first point of the trail, when the point before it lies before `from`. |

  - Reach is one game tick's run: 2 tiles plus 6 of margin for lag, 8 in all, and 4 plus 6 while
    both points are on a boat (`is_on_boat`). The time since the point before plays no part: a
    point is the tick on which the tile changed, so a player who stood for 40 seconds and is then
    110 tiles away didn't walk there.
  - More labels may be added. Treat one you don't know as "not walked".
  - The label belongs to the pair of points, so it is only right on the trail as the hub returns it.
    When you thin a trail, keep both points of every step that isn't a `move`.
  - A point a minute from an older plugin (its `at` is a whole minute) is judged by the time since
    the point before instead, 2 tiles per 0.6 s: a minute's run is within reach, so a teleport of
    under 200 tiles reads as a `move`.
  - A stretch of a 1.6 trail that never reached the hub and was walked reads as a `teleport` when
    it is shorter than 5 minutes: the hub can't tell it from one.
  - A late message can add a point between two you already have, which changes the label of the
    point after it.
  - When `truncated` is true the first point has its label too: the hub knows the point it left out.
- **`world`** is the world of the message a point arrived in, so tiles walked just before a hop carry
  the new world.
- **Limit.** At most 20,000 points, the newest ones. `truncated: true` means older points in the
  range were left out: ask again with `to` set to the first point's `at` (that point is returned
  again, as the last one).
- **Following a trail.** Ask with `from` set to the last point's `at`. A point can be dated up to 10 s
  after the hub received it, and a late message can add points up to 30 minutes back: a message up to
  15 minutes old keeps its own times, and its points may lie up to 15 minutes before it. So overlap the
  requests rather than assuming the trail only grows at its end.
- **The same stretch twice.** The hub knows a point it already has by its time. It keeps the
  plugin's times only for a message dated between 15 minutes before and 10 s after the moment it
  arrives; a message from a PC whose clock runs further ahead is dated by its arrival instead. When
  the plugin sends such a message a second time although the first copy arrived (after a timeout,
  for one), the two copies are dated differently and the trail holds that stretch twice: the same
  tiles again some seconds later, 30 s later in a test with a clock 30 s ahead. A stretch that
  waited in the plugin's queue during an outage arrives late and is dated differently from the
  messages that arrived on time: it lies some seconds late in the trail, mixed with what was
  walked after it. A correct clock gives every point once. Up to plugin 1.6.1 only a message with
  an event in it is sent again; HA Exporter pull request 45 (unmerged on 2026-10-06) sends every
  message with trail points again. The hub leaves this as it is (D-102,
  [PLUGIN-14](gotchas/plugin.md#plugin-14)).

### GET /locations?accounts=a,b&from=&to=

The location trails of several accounts in one call (`location_history`), in request order, each
what `/accounts/{id}/locations` returns for the same range. 1–10 accounts with a user key, 1–50 with
a service key (D-92). If any account isn't readable, the whole request is a 404 naming it. Default:
the last 24 hours.

One response holds at most 100,000 points, shared equally between its accounts: each trail gets
`min(20,000, ⌊100,000 / accounts⌋)` points, so up to 5 accounts nothing differs from the per-account
endpoint, 8 accounts get 12,500 each and 50 get 2,000. Each trail has its own `truncated`; page a
truncated one with `to`, per account or in a call that names fewer accounts.

    GET /api/v1/locations?accounts=oC8RsqiTuyak,jHSfP5UICcQt

    {"data":{"from":"…","to":"…","accounts":[
      {"account":{"id":"oC8RsqiTuyak","name":"Alpha Main"},"truncated":false,"points":[{"at":"2026-09-29T13:24:25.236Z","x":3164,"y":3487,"plane":0,"world":302,"is_on_boat":false,"via":null},…]},
      {"account":{"id":"jHSfP5UICcQt","name":"Bravo Alt"},"truncated":false,"points":[]}]},"meta":{…}}

### GET /leaderboards/gains?skill=&period=day|week|month

The guild's gains leaderboards over accounts whose `stats` the key reads: the top 10 per skill, only
accounts that gained XP.

- Without `skill`: Overall first, then every skill anyone gained XP in.
- With `skill`: exactly that board.
- Default `period=day`.

    GET /api/v1/leaderboards/gains?skill=attack

    {"data":{"period":"day","from":"2026-09-29T00:00:00.000Z","to":"2026-09-29T14:14:12.533Z",
     "leaderboards":[{"skill":"Attack","entries":[{"rank":1,"account":{"id":"oC8RsqiTuyak","name":"Alpha Main"},"gain":5000}]}]},"meta":{…}}

### GET /leaderboards/loot?period=day|week|month&limit=

The period's most valuable drops over accounts whose `events` the key reads (D-94).

- Only `loot` and `pk_loot` events with a `value_gp`, never on a special world, that occurred between
  `from` and `to`.
- Highest `value_gp` first; drops of equal value newest first. `rank` counts from 1.
- `period` as for the gains leaderboards (`day` since local midnight in the key creator's time zone,
  UTC for a service key; `week`/`month` the last 7/30 days). Default `period=day`.
- `limit`: 1–50, default 10.
- Each `event` is exactly what `/events` serves for it, `data.location` removed the same way. A drop
  can show up here a few seconds before the `/events` cursor serves it, which holds back events
  younger than its settle margin.
- `entries` is empty when nothing qualifies, also for a key that reads no account's `events`.
- The admin's guild feed filter (D-81) doesn't apply, as for the rest of the API.

    GET /api/v1/leaderboards/loot?period=week&limit=2

    {"data":{"period":"week","from":"2026-09-22T14:14:12.533Z","to":"2026-09-29T14:14:12.533Z",
     "entries":[
      {"rank":1,"event":{"id":"01a0ed84-1827-7008-ad3e-ffb85a03171a","type":"loot","account":{"id":"oC8RsqiTuyak","name":"Alpha Main"},
        "occurred_at":"2026-09-29T14:13:40.046Z","received_at":"2026-09-29T14:13:42.046Z","value_gp":35237280,
        "item_id":11828,"npc_id":3162,"skill":null,"level":null,"tier":null,"points":null,"special_world":false,
        "data":{"type":"loot","eventId":"d57690f0-…","timestamp":1790691220046,"data":{…}},
        "title":"Loot","line":"Alpha Main received Armadyl chestplate (35.2M) from Kree'arra"}},
      {"rank":2,"event":{"id":"…","type":"pk_loot","account":{"id":"jHSfP5UICcQt","name":"Bravo Alt"},"value_gp":1250000,…}}]},
     "meta":{"generated_at":"…"}}

### GET /members/{discord_id}

**Service keys only** (D-100). Whether one Discord account is a member of the hub, and an admin. It is
for a guild service that signs people in with Discord itself, such as the live map, and lets the hub
decide who may come in. One Discord user id in, one verdict out: there is no list and no lookup by
name, and the key needs no category for it.

    GET /api/v1/members/100000000000000042

    {"data":{"discord_id":"100000000000000042","member":true,"is_admin":false,"name":"Owner"},"meta":{"generated_at":"…"}}

    GET /api/v1/members/100000000000000099

    {"data":{"discord_id":"100000000000000099","member":false,"is_admin":false,"name":null},"meta":{"generated_at":"…"}}

A service key always gets a `200` for a well-formed id:

- `member` is `true` when a hub user with that Discord id exists and is active. `name` is their display
  name on the hub and `is_admin` their admin flag.
- Otherwise the answer is `member: false`, `is_admin: false`, `name: null`. An id the hub has never seen
  and a user who left the guild or was removed look exactly alike.
- `is_admin` is for the service's own admin pages. It changes nothing about what the key reads: a
  service key reads what the guild audience sees, whoever is signed in to the service (D-89).
- The verdict is the hub's state at the time of the request: someone who is offboarded answers
  `member: false` on the next one.

Other answers:

- An id that isn't 15 to 22 digits is a `400 invalid_request`, never a 404.
- A **user key** gets `404 not_found` with the body of an unknown path, whoever created it: the endpoint
  doesn't exist for personal keys.
- So for a service key a 404 means one thing: the hub is older than this endpoint.

The two error bodies:

    {"error":{"code":"invalid_request","message":"discord_id must be a Discord user id (15 to 22 digits)"}}
    {"error":{"code":"not_found","message":"There is no such endpoint in API v1."}}

### GET /openapi.json

The OpenAPI 3.1 description of all of the above, generated from the same schemas the routes validate
with (D-75). Public; no key needed.

## The events cursor

1. Start with `GET /events?cursor=now`. You get no events, just `meta.next_cursor`: "everything from now
   on". Leave out `cursor` instead to get the newest `limit` events first.
2. Then always pass the previous `meta.next_cursor`. You get the events stored after it, oldest first,
   and a new cursor. Store the cursor after processing the page.
3. Fewer than `limit` events means "caught up for now". Poll again later with the same cursor; it stays
   unchanged while nothing new has arrived.

Other rules:

- The cursor always moves forward, also past events your filters leave out. Cursors are opaque strings;
  don't parse them.
- The feed only serves events stored at least 10 s ago, so it can never skip an event whose write is
  still being committed (D-73). Expect an event 10–15 s after the hub received it.
- `occurred_at` is when it happened in game, as the plugin stamped it, clamped to the 15 minutes up to
  `received_at` (D-17). `received_at` is when the hub got it.

## Events in a time range

`GET /events?from=&to=` answers "what happened between A and B" (D-98), for example the events along
a player's location trail. Giving `from`, `to` or both selects this mode. The rest of the request is as
on the feed: `accounts`, `types`, `min_value`, `limit`, the event shape, the 404 for an unreadable
account and the removal of `data.location`.

1. Ask for the range, e.g. `GET /events?accounts=oC8RsqiTuyak&from=2026-09-01T00:00:00Z&to=2026-10-01T00:00:00Z`.
   You get the **newest** `limit` events with `occurred_at` from `from` to `to`, both included, newest
   first. Events of the same instant come in the reverse of the order the hub stored them.
2. `meta.next_cursor` is the cursor of the next, older page, or `null` when this page is the last one.
   Pass it as `cursor` with the same `from`, `to` and filters. Stop whenever you have enough.

Other rules:

- Defaults: `to` = now, `from` = `to` − 30 days. There is no maximum range. A `from` after `to` is a 400.
- Without `accounts`, the range covers every account whose `events` the key reads, as one merged stream.
- Paging visits every event once, without gaps or repeats, whatever arrives in the meantime: new events
  are newer than the cursor.
- There is no settle margin in this mode, so an event can show up here a few seconds before the feed
  serves it. An event that arrives late (the plugin resends for up to about 10 minutes) with an
  `occurred_at` in a stretch already paged is not revisited by that walk; read the newest part of the
  range again to pick it up.
- The two modes have different cursors. `cursor=now` or a feed cursor together with `from`/`to`, and a
  range cursor without them, are a 400.
- A hub from before this feature ignores `from` and `to` (unknown parameters are ignored) and answers
  with the feed's newest `limit` events and a `next_cursor` that is never `null`. `/openapi.json`
  lists `from` among `/events`' parameters only where the range read exists.

    GET /api/v1/events?accounts=oC8RsqiTuyak&from=2026-09-29T00:00:00Z&to=2026-09-30T00:00:00Z&limit=2

    {"data":[{"id":"01a0ed84-1827-7008-ad3e-ffb85a03171a","type":"loot","occurred_at":"2026-09-29T14:13:40.046Z",…},
             {"id":"01a0ed71-…","type":"level_up","occurred_at":"2026-09-29T13:58:02.511Z",…}],
     "meta":{"generated_at":"…","count":2,"next_cursor":"cjE6MTc5MDY5MDI4MjUxMToxNw"}}

## Known consumers

- **Home Assistant** ("hub mode" in ha-osrs-data):
  - poll `/snapshot` every 2–10 s with `If-None-Match` for sensors (online, world, HP, prayer, skills,
    location);
  - follow `/events?cursor=` to fire HA events.
  - Suggested key: `stats`, `events`, `activity` (+ `location_live` for coordinates).
  - This replaces pairing every RuneLite client with Home Assistant.
- **Discord bot:**
  - `/events?cursor=` for the drop feed (e.g. `types=loot,collection_log,pk_loot&min_value=1000000`);
  - `/leaderboards/gains?period=day|week|month`;
  - `/accounts?online=true` for "who's online".
  - Suggested key: `events`, `stats`, `activity`.
- **Live map** ([ha-osrs-map](https://github.com/RedFirebreak/ha-osrs-map), polling the hub
  server-side with a **service key**, D-88):
  - poll `/snapshot?since=` (1/s at most; every 2–10 s is plenty) with a key holding `location_live` and
    `activity`, and a full refresh without `since` now and then to drop accounts that left. Browsers
    could call it directly too (CORS).
  - Only accounts that share `location_live` with the guild (the default since D-82; accounts the hub
    knew before that default keep `private` until their owner changes it), and whose players send
    their location, have a `location`. Grey out `stale: true` positions.
  - `owner.discord_id` and `account_hash` link a hub account to the player who paired with the map
    directly (D-90, D-91); `/xp?accounts=` and `/locations?accounts=` take 50 accounts per call
    (D-92).
  - `/locations?accounts=&from=` (with `location_history`) for the trails: every tile since plugin
    1.6 (D-102). Always send `from`, check `truncated`, and for a long window page backwards with
    `to` or thin on your side; a week of play is far more than one response carries. `via` on each
    point says whether to draw a line to it, a teleport, an entrance or nothing (D-103).
  - `game_state` on `/snapshot` (with `activity`) for its status panel, and `/leaderboards/loot`
    (with `events`) for its top-drops panel (D-94).
  - `/events?accounts=&from=&to=` (with `events`) for the events along a trail: the last 24 hours or
    7 days, or one play session of the player it is watching (D-98).
  - `/accounts/{id}/sessions?from=` (with `activity`) for that player's play sessions of the last 7
    days, which its trail length menu offers next to 24 hours and 7 days. A session that is still
    going on has no `ended_at`; the map then asks for the trail from its start with no `to`.
  - `/members/{discord_id}` to decide who may sign in to the map and who is an admin there (D-100): the
    map signs people in with Discord itself and asks the hub about their Discord user id. It keeps no
    accounts of its own. A 404 tells it the hub is too old to have the endpoint.
  - There is no push for keys yet (D-93): polling is the contract.
