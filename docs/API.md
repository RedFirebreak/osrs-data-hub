# osrs-data-hub API v1

A read-only JSON API over the OSRS account data that guild members' HA Exporter RuneLite plugins send to
the hub. It is **pull-only**: poll `/snapshot` and the `/events` cursor feed; there are no webhooks (D-3).

- Base URL: `https://<your hub>/api/v1`
- Interactive reference: `https://<your hub>/docs/api`
- OpenAPI 3.1 document: `https://<your hub>/api/v1/openapi.json` (public, no key needed)

Design decisions: D-69 … D-77 in [ARCHITECTURE.md](ARCHITECTURE.md).

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
| Per key, all endpoints | 120 requests per sliding minute | `429 rate_limited` + `Retry-After` |
| Per key, `/snapshot` | 1 request per second | `429` + `Retry-After: 1` |
| Failed authentications per client IP | 30 per minute | every request from that IP gets `429` until the window passes |

Every authenticated response carries these headers:

- `X-RateLimit-Limit`: 120;
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
| 404 | `not_found` | unknown or unreadable account, or an unknown path |
| 429 | `rate_limited` | over a limit; wait `Retry-After` seconds |
| 503 | `unavailable` | the hub is busy or its database is unreachable; retry after `Retry-After` |
| 500 | `internal_error` | a bug; nothing about it is revealed |

    {"error":{"code":"not_found","message":"Account not found."}}
    {"error":{"code":"invalid_request","message":"The request is invalid.","details":[{"path":"from","message":"must be an ISO-8601 date-time with Z or an offset"}]}}

## Endpoints

Examples are shortened with `…`.

### GET /me

The key, its creator and how many accounts it can see. Useful as a connection test.

    GET /api/v1/me

    {"data":{"key":{"id":"01a0ed84-1852-7784-9a43-157469f2bddc","name":"Home Assistant","prefix":"NM5kHo1WTn",
     "categories":["stats","events","activity","location_live"],"account_scope":"all_visible","expires_at":null},
     "user":{"name":"Owner"},"visible_accounts":2},"meta":{"generated_at":"2026-09-29T14:14:12.330Z"}}

### GET /accounts?names=&ids=&online=

The visible accounts, sorted by name.

Parameters:

- `names`: comma-separated display names, case-insensitive (at most 100);
- `ids`: comma-separated account ids (at most 100);
- `online=true|false`.

With `names` and/or `ids`, only matching accounts are returned. `online`, `world` and `last_seen` are
`null` without `activity`, and such accounts never pass an `online` filter.

    GET /api/v1/accounts?online=true

    {"data":[{"id":"oC8RsqiTuyak","name":"Alpha Main","type":0,"type_label":"Normal","online":true,"world":302,
     "last_seen":"2026-09-29T14:13:42.046Z"}],"meta":{"generated_at":"…","count":1}}

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

    {"data":{"id":"oC8RsqiTuyak","name":"Alpha Main","type":0,"type_label":"Normal","first_seen":"2026-09-29T13:24:12.046Z",
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

### GET /snapshot?since=

Every visible account in one response, built for polling every 2–10 s. Limited to 1 request per second
per key.

Each account has `id`, `name`, `type`, `type_label` and `categories`. The other fields depend on the
key's categories on that account:

- `activity`: `online`, `world`, `special_world`, `last_seen`, `hp`, `prayer`, `spellbook`;
- `location_live`: `location` (with `stale` and `updated_at`);
- `stats`: `skills`;
- `equipment`: `equipment`;
- `inventory`: `inventory`.

A field is omitted without its category, and `null` when readable but never sent.

    GET /api/v1/snapshot
    → 200, ETag: W/"iJSsXZ1wy4SjrMLJMHceEMf2oLc", Last-Modified: Tue, 29 Sep 2026 14:13:42 GMT

    {"data":[{"id":"oC8RsqiTuyak","name":"Alpha Main","type":0,"type_label":"Normal","categories":["stats","events","activity","location_live"],
      "online":true,"world":302,"special_world":false,"last_seen":"2026-09-29T14:13:42.046Z",
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

The same series for 1–10 accounts, in request order. If any account isn't readable (`stats`), the whole
request is a 404 naming it, as if it didn't exist.

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

### GET /events?cursor=&types=&accounts=&min_value=&limit=

The cursor feed of events on accounts whose `events` category the key can read (see
[The events cursor](#the-events-cursor)).

Parameters:

- `types`: `loot`, `pk_loot`, `death`, `level_up`, `collection_log`, `superior_spawn`,
  `achievement_diary`, `combat_task`, or an unknown plugin type as sent;
- `accounts`: up to 100 ids, each readable, else 404;
- `min_value`: `value_gp` ≥ this;
- `limit`: 1–500, default 100.

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
     "items":[{"id":10828,"name":"Helm of Neitiznot","quantity":1,"ge_price":47601,"ha_price":30000,"equipment_slot":"HEAD"},…]}]},"meta":{…}}

### GET /accounts/{id}/wealth?from=&to=

Carried value (inventory + equipment at GE prices) per UTC day, oldest first (`inventory`). Default: 30
days.

    {"data":{"account":{…},"from":"…","to":"…","days":[{"day":"2026-09-29","last_value":84474944,"max_value":84474944}]},"meta":{…}}

### GET /accounts/{id}/locations?from=&to=

The location trail, at most one point per minute, oldest first (`location_history`, kept 30 days).
Default: 30 days.

    {"data":{"account":{…},"from":"…","to":"…","points":[{"at":"2026-09-29T13:24:00.000Z","x":3164,"y":3487,"plane":0,"world":302,"is_on_boat":false},…]},"meta":{…}}

### GET /leaderboards/gains?skill=&period=day|week|month

The guild's gains leaderboards over accounts whose `stats` the key reads: the top 10 per skill, only
accounts that gained XP.

- Without `skill`: Overall first, then every skill anyone gained XP in.
- With `skill`: exactly that board.
- Default `period=day`.

    GET /api/v1/leaderboards/gains?skill=attack

    {"data":{"period":"day","from":"2026-09-29T00:00:00.000Z","to":"2026-09-29T14:14:12.533Z",
     "leaderboards":[{"skill":"Attack","entries":[{"rank":1,"account":{"id":"oC8RsqiTuyak","name":"Alpha Main"},"gain":5000}]}]},"meta":{…}}

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
- **Live map:**
  - poll `/snapshot?since=` (1/s at most; every 2–10 s is plenty) with a key holding `location_live` and
    `activity`. Browsers can call it directly (CORS).
  - Only accounts that share `location_live` with you (the guild by default, D-82; accounts the hub
    knew before that default keep `private` until their owner changes it), and whose players send
    their location, have a `location`. Grey out `stale: true` positions.
  - Fetch without `since` now and then to drop accounts that left.
