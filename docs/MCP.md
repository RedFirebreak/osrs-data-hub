# The hub as an MCP server

The hub answers questions from an AI assistant (Claude, Claude Code, Cursor, the Claude API) through
the [Model Context Protocol](https://modelcontextprotocol.io). "What did Stefan do all day?", "who
has a Tumeken's shadow?" and "biggest drops this week?" each become a tool call or two against the
same read-only data API v1 serves ([API.md](API.md)). Design: D-128 … D-135 in
[ARCHITECTURE.md](ARCHITECTURE.md).

- **Endpoint:** `POST https://<your hub>/api/v1/mcp`, Streamable HTTP, stateless, JSON responses.
  `GET` and `DELETE` answer 405: there are no sessions and nothing is pushed.
- **Credential:** an ordinary API key (`ohub_…`), sent as `Authorization: Bearer <key>`. A member's
  key sees what that member sees, narrowed to the key's categories and accounts; a service key sees
  the guild audience. There is no MCP-only permission.
- **Limits:** every POST is one request against the key's per-minute limit (120 for a user key, 600
  for a service key) and counts in the `hub_api_*` metrics under the route group `mcp`. A message is
  at most 64 KiB.
- **Read-only:** no tool writes anything, and every tool reads only what a REST endpoint also serves
  (D-131). The tool descriptions name that endpoint.

## A key for an assistant

On the hub's **API keys** page, **Create key**, then **For an AI assistant**. That ticks `stats`,
`events`, `activity`, `location_history` and `hiscores`, and names the key "AI assistant". Add
`equipment` and `inventory` for questions about gear and wealth, and `location_live` for "where is X
right now". Pick the accounts if the assistant should only see some. The key is shown once.

What the key can't read, the tools say so ("this key can't read Alpha Main's XP: it needs the
"stats" category, and the owner has to share it with you"), so the assistant can explain a missing
answer instead of guessing. `hub://me` lists the key's categories.

## Connecting

Replace `hub.example.com` with your hub's address and `ohub_…` with the key.

**Claude Code**

```bash
claude mcp add --transport http scapekeeper https://hub.example.com/api/v1/mcp \
  --header "Authorization: Bearer ohub_..."
```

**Cursor** (`~/.cursor/mcp.json`, or `.cursor/mcp.json` in a project)

```json
{
  "mcpServers": {
    "scapekeeper": {
      "url": "https://hub.example.com/api/v1/mcp",
      "headers": { "Authorization": "Bearer ohub_..." }
    }
  }
}
```

**Claude Desktop** (`claude_desktop_config.json`, through the `mcp-remote` bridge, which needs Node)

```json
{
  "mcpServers": {
    "scapekeeper": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://hub.example.com/api/v1/mcp",
        "--header",
        "Authorization:Bearer ohub_..."
      ]
    }
  }
}
```

**The Claude API** (the MCP connector of the Messages API, or the Agents SDK): a server of type
`url` with `url` set to the endpoint and `authorization_token` set to the key.

**Claude.ai** connects to remote servers by signing in with OAuth rather than a pasted key. The hub
gets that sign-in in M9 (§14): it will create an ordinary user key for the connection, visible and
revocable on the API keys page. Until then, use one of the clients above.

**By hand** (what a client sends; `Accept` must list both types):

```bash
curl -s https://hub.example.com/api/v1/mcp \
  -H "Authorization: Bearer ohub_..." \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"who_has","arguments":{"item":"shadow"}}}'
```

## Tools

Every result is JSON that opens with a one-line `summary` the assistant can quote and ends with
`generated_at`. Names come before ids, GP values are also formatted (`35.2M`), and lists stop at 50
with `truncated` or a `next_cursor` (D-132). An `account` input takes the in-game name in any case,
a unique part of it, or the account's id; a name that matches several accounts is an error listing
them (D-134). Dates are ISO: `2026-11-01` is that whole UTC day, `2026-11-01T18:00:00Z` a moment.

| Tool | Inputs | Answers | Needs | REST twin |
| --- | --- | --- | --- | --- |
| `list_accounts` | `online?`, `names?` | name, id, type, owner, online, world, last seen, the categories the key reads on each | (`activity` for online) | `GET /accounts` |
| `get_account` | `account`, `sections?` (`stats`, `presence`, `equipment`, `inventory`, `wealth`; default the first two), `detail?` | levels (XP with `detail`), online and world, worn gear, the inventory merged by item, wealth (bank + carried) | the section's category; wealth `inventory` | `GET /accounts/{id}`, `/accounts/{id}/wealth` |
| `get_gains` | `account`, `period?` (day, week, month, year) or `from`/`to` | XP gained per skill, most first, and the total | `stats` | `GET /accounts/{id}/gains` |
| `recent_events` | `types?`, `accounts?`, `min_value?`, `from?`, `to?`, `limit?` (≤ 50), `cursor?` | events newest first: type, account, time, value, one line | `events` | `GET /events?from=&to=` |
| `search_events` | `item?`, `npc?` (one of them), and the inputs of `recent_events` | the same, for drops with that item or from that NPC, deaths to it, superiors | `events` | `GET /events?item=&npc=` |
| `leaderboard` | `kind` (`gains` or `loot`), `skill?`, `period?` (day, week, month), `limit?` | ranks with names and XP, or the most valuable drops with their line | `stats` / `events` | `GET /leaderboards/gains`, `/leaderboards/loot` |
| `get_hiscores` | `accounts` (≤ 10, 50 with a service key), `fields?` (`bosses`, `clues`, `minigames`, `skills`) | kill counts most first, clues, minigames, levels and ranks, and when they were read | `hiscores` | `GET /hiscores?accounts=` |
| `collection_log` | `account`, `source?`, `since?`, `limit?` | the total from the hiscores, the slots the hub saw as `item (kc N) from source on day`, counts per source | `events` or `hiscores` | `GET /accounts/{id}/collection-log` |
| `who_has` | `item`, `accounts?` | per matching item its holders with when and the kill count, and `searchable`: how many accounts were searched | `events` | `GET /collection-log?item=` |
| `sessions` | `account`, `from?`, `to?` | sessions newest first: start, end or `ongoing`, minutes, worlds; the total | `activity` | `GET /accounts/{id}/sessions` |
| `locations` | `account`, `from?`, `to?`, `summarise?` (default true) | stays per map region (minutes, how the player arrived), the regions with most time, teleports; or the last 200 points | `location_history` | `GET /accounts/{id}/locations` |

Regions are the game's numeric map regions (64 × 64 tiles) until the hub has named regions (M8).
`day_summary` ("what did X do all day") comes with M8 too.

## Resources

- `hub://accounts`: the accounts the key can see, with id, name, type, owner and the categories the
  key reads on each. The table the assistant resolves names against.
- `hub://me`: the guild, the hub's name and version (`HUB_VERSION`, set by the release build; `dev`
  otherwise), the features this hub has (`who_has`, `event_search`, …), the key's kind, name,
  categories, rate limit and expiry, and whose key it is.

## Prompts

- `guild_today`: who is online, the day's top gains, the big drops and new log slots.
- `player_day` (`account`, `date?`): a light write-up of one account's day.
- `who_has` (`item`): the lookup, phrased as an answer.

## Errors

- A tool that can't answer returns a result with `isError` and a sentence saying why: an unknown or
  ambiguous name, a category the key lacks, a bad date or argument. The assistant reads it.
- Anything unexpected is logged on the hub and answered with "could not answer this right now".
- Before the server sees a message, the key wrapper answers like every v1 route: 401 for a bad key,
  429 with `Retry-After` over the limit, 413 for a body over 64 KiB, 406 when the client doesn't
  accept JSON.

## Behind a reverse proxy

Nothing beyond [OPERATIONS.md §3](OPERATIONS.md#3-reverse-proxy): the endpoint answers plain JSON
(no stream), so buffering doesn't matter. Pass `Authorization` and the `Mcp-*` headers through, and
don't add CORS headers: the hub answers the browser preflight itself.

## Code

- `apps/web/src/app/api/v1/mcp/route.ts`: the route (`withApiKey`, body cap, the transport).
- `apps/web/src/lib/mcp/server.ts`: one server per request, the resources and prompts.
- `apps/web/src/lib/mcp/tools.ts`: the tools; `resolve.ts` the account names; `trim.ts` the result
  shape.
- Tests: `lib/mcp/tools.test.ts` (each tool's trimmed answer) and `app/api/v1/mcp.test.ts` (MCP over
  HTTP with a real key).
