/**
 * The OpenAPI 3.1 document of /api/v1 (D-75), built at request time from the zod schemas the routes
 * parse and answer with (schemas.ts): parameters with `io: 'input'`, responses with `io: 'output'`,
 * shared response shapes under components.schemas. No extra dependency, no build step, and the route
 * tests parse real responses with the same schemas, so the document can't drift from the API.
 *
 * `servers` comes from APP_URL (getConfig().appOrigin), never from request.url, which is the server's
 * bind address (NEXT-2, D-26).
 */
import { getConfig } from '@hub/core';
import {
  API_EVENTS_SETTLE_MS,
  API_RATE_LIMIT,
  API_RATE_WINDOW_MS,
  EVENTS_DEFAULT_LIMIT,
  EVENTS_MAX_LIMIT,
  FAILED_AUTH_LIMIT,
  FAILED_AUTH_WINDOW_MS,
  HISTORY_DEFAULT_DAYS,
  LOOT_LEADERBOARD_DEFAULT_LIMIT,
  LOOT_LEADERBOARD_MAX_LIMIT,
  MAX_BULK_ACCOUNTS,
  MAX_BULK_ACCOUNTS_SERVICE,
  SERVICE_KEY_RATE_LIMIT,
  SNAPSHOT_RATE_LIMIT,
  SNAPSHOT_RATE_WINDOW_MS,
  SNAPSHOT_SINCE_OVERLAP_MS,
  XP_DEFAULT_DAYS,
} from '@hub/server';
import { z } from 'zod';
import * as S from './schemas';

/** One GET operation of the document. */
interface OperationSpec {
  /** OpenAPI path, relative to the server URL (…/api/v1). */
  path: string;
  operationId: string;
  tag: string;
  summary: string;
  description: string;
  /**
   * The 200 body, a `{ data, meta }` envelope exported by schemas.ts. Its export name there is its
   * name under components.schemas (componentName), so an endpoint names its response once.
   */
  response: z.ZodType;
  query?: z.ZodObject;
  /** The `{id}` account path parameter. */
  accountPath?: boolean;
  /** 404 for accounts the key can't read (path id or a list parameter). */
  notFound?: boolean;
  /** 304 with If-None-Match (/snapshot). */
  conditional?: boolean;
}

const SECONDS = (ms: number) => Math.round(ms / 1000);

/** Every operation in the document, in the order the reference shows them. */
export const OPERATIONS: readonly OperationSpec[] = [
  {
    path: '/me',
    operationId: 'getMe',
    tag: 'Key',
    summary: 'The key and its creator',
    description:
      'The key behind the request (kind, name, prefix, categories, scope, rate limit, expiry), its creator’s display name (`user`, null for a service key) and how many accounts it can see right now. Handy as a connection test.',
    response: S.MeResponse,
  },
  {
    path: '/accounts',
    operationId: 'listAccounts',
    tag: 'Accounts',
    summary: 'List visible accounts',
    description:
      'Every account the key may see, sorted by name, each with its `owner` (the active owner as the guild page shows them, or null) and, for service keys, its `account_hash`. `online`, `world` and `last_seen` are null for accounts whose `activity` the key can’t read. `meta.count` is the number returned.',
    response: S.AccountsResponse,
    query: S.AccountsQuery,
  },
  {
    path: '/accounts/{id}',
    operationId: 'getAccount',
    tag: 'Accounts',
    summary: 'One account’s current state',
    description:
      'The account’s current state, section by section. A section of a category the key can’t read on this account is **omitted**; a readable section the player’s plugin never sent is `{ "shared": false, "updated_at": null }` ("not shared"), never an empty value. Every sent section carries `updated_at`.',
    response: S.AccountResponse,
    accountPath: true,
    notFound: true,
  },
  {
    path: '/snapshot',
    operationId: 'getSnapshot',
    tag: 'Snapshot',
    summary: 'Current state of every visible account',
    description: [
      `Built for polling every 2–10 s (the live map, Home Assistant). Limited to ${SNAPSHOT_RATE_LIMIT} request per ${SECONDS(SNAPSHOT_RATE_WINDOW_MS)} s per key, on top of the general limit.`,
      '',
      'Each account carries `id`, `name`, `type`, `type_label`, `owner` and `categories` (and `account_hash` for service keys); every other field belongs to one category and is **omitted** when the key can’t read that category on the account, and **null** when it can but the plugin never sent it.',
      '',
      'Send the last `ETag` as `If-None-Match`: while nothing you would see has changed, the answer is `304 Not Modified` without a body (it still counts towards the rate limits). With `since` (the previous `meta.last_modified`), only accounts that changed after it are returned, re-sending those that changed up to ' +
        `${SECONDS(SNAPSHOT_SINCE_OVERLAP_MS)} s before it; accounts whose \`activity\` the key can’t read are always returned, and an account that leaves the key’s scope simply stops appearing, so fetch without \`since\` now and then. A location older than 2 minutes has \`stale: true\`.`,
    ].join('\n'),
    response: S.SnapshotResponse,
    query: S.SnapshotQuery,
    conditional: true,
  },
  {
    path: '/accounts/{id}/xp',
    operationId: 'getAccountXp',
    tag: 'XP and gains',
    summary: 'XP series of one account',
    description: `XP per skill over time (\`stats\`). Defaults: Overall, the last ${XP_DEFAULT_DAYS} days, \`resolution=auto\`.`,
    response: S.XpResponse,
    query: S.XpQuery,
    accountPath: true,
    notFound: true,
  },
  {
    path: '/xp',
    operationId: 'getXp',
    tag: 'XP and gains',
    summary: 'XP series of several accounts',
    description: `The same series for several accounts at once, in request order (\`stats\`): up to ${MAX_BULK_ACCOUNTS} accounts with a user key, ${MAX_BULK_ACCOUNTS_SERVICE} with a service key. An account the key can’t read makes the whole request 404, exactly like an unknown id.`,
    response: S.XpMultiResponse,
    query: S.XpMultiQuery,
    notFound: true,
  },
  {
    path: '/accounts/{id}/gains',
    operationId: 'getAccountGains',
    tag: 'XP and gains',
    summary: 'Gains per skill',
    description:
      'XP gained per skill in a period or an explicit range (`stats`): every skill the account has, 0 when nothing was gained. Default `period=day`.',
    response: S.GainsResponse,
    query: S.GainsQuery,
    accountPath: true,
    notFound: true,
  },
  {
    path: '/events',
    operationId: 'getEvents',
    tag: 'Events',
    summary: 'Event cursor feed, or the events of a time range',
    description: [
      'Loot, level-ups, deaths, collection log, diaries, combat tasks and superiors of the accounts whose `events` the key may read, ordered by the order the hub stored them, for the Discord bot and Home Assistant automations.',
      '',
      `**Cursor semantics.** Start with \`cursor=now\` (no events, just the current cursor) or without a cursor (the newest \`limit\` events, default ${EVENTS_DEFAULT_LIMIT}, at most ${EVENTS_MAX_LIMIT}). Then always pass the previous \`meta.next_cursor\`: you get the events after it, oldest first, and a new cursor. Fewer than \`limit\` events means "caught up for now". The cursor always moves forward, also past events your filters leave out, and is unchanged while nothing new has arrived. Cursors are opaque; keep them as strings.`,
      '',
      `The feed only serves events stored at least ${SECONDS(API_EVENTS_SETTLE_MS)} s ago, so a cursor can never skip an event that is still being committed: expect an event 10–15 s after the hub received it. \`occurred_at\` is when it happened in game, \`received_at\` when the hub got it (the plugin may resend events up to ~10 minutes late).`,
      '',
      `**Time range.** With \`from\` and/or \`to\` the request reads history instead of following the feed: the events with \`occurred_at\` from \`from\` to \`to\` (both included; \`to\` defaults to now, \`from\` to ${HISTORY_DEFAULT_DAYS} days before \`to\`), **newest first**, with the same accounts, filters, \`limit\` and event shape. \`meta.next_cursor\` is the cursor of the next (older) page, or \`null\` when the page is the range’s last; pass it as \`cursor\` with the same \`from\`, \`to\` and filters. Pages are keyed on the event’s time and storage order, so every event is visited once, events of the same instant included, whatever arrives meanwhile. There is no settle margin here: an event can appear a few seconds before the feed serves it, and one that arrives late in a stretch already paged isn’t revisited. The two modes have different cursors: \`cursor=now\` or a feed cursor with \`from\`/\`to\`, or a range cursor without them, is a 400.`,
    ].join('\n'),
    response: S.EventsResponse,
    query: S.EventsQuery,
    notFound: true,
  },
  {
    path: '/accounts/{id}/sessions',
    operationId: 'getAccountSessions',
    tag: 'Histories',
    summary: 'Play sessions',
    description: `Play sessions overlapping the range, newest first (\`activity\`). Default: the last ${HISTORY_DEFAULT_DAYS} days.`,
    response: S.SessionsResponse,
    query: S.HistoryQuery,
    accountPath: true,
    notFound: true,
  },
  {
    path: '/accounts/{id}/equipment-history',
    operationId: 'getAccountEquipmentHistory',
    tag: 'Histories',
    summary: 'Equipment change log',
    description: `Every change of the worn set in the range, newest first, each with the whole set after it (\`equipment\`). Default: the last ${HISTORY_DEFAULT_DAYS} days.`,
    response: S.EquipmentHistoryResponse,
    query: S.HistoryQuery,
    accountPath: true,
    notFound: true,
  },
  {
    path: '/accounts/{id}/wealth',
    operationId: 'getAccountWealth',
    tag: 'Histories',
    summary: 'Carried wealth per day',
    description: `Carried value (inventory + equipment at GE prices) per UTC day, oldest first (\`inventory\`). Default: the last ${HISTORY_DEFAULT_DAYS} days.`,
    response: S.WealthResponse,
    query: S.HistoryQuery,
    accountPath: true,
    notFound: true,
  },
  {
    path: '/accounts/{id}/locations',
    operationId: 'getAccountLocations',
    tag: 'Histories',
    summary: 'Location trail',
    description: `The location trail, at most one point per minute, oldest first (\`location_history\`; kept 30 days). Default: the last ${HISTORY_DEFAULT_DAYS} days.`,
    response: S.LocationsResponse,
    query: S.HistoryQuery,
    accountPath: true,
    notFound: true,
  },
  {
    path: '/locations',
    operationId: 'getLocations',
    tag: 'Histories',
    summary: 'Location trails of several accounts',
    description: `The location trails of several accounts in one call, in request order (\`location_history\`): up to ${MAX_BULK_ACCOUNTS} accounts with a user key, ${MAX_BULK_ACCOUNTS_SERVICE} with a service key, each trail exactly what \`/accounts/{id}/locations\` returns for the same range (at most one point per minute, oldest first, kept 30 days). An account the key can’t read makes the whole request 404. Default: the last ${HISTORY_DEFAULT_DAYS} days.`,
    response: S.LocationsMultiResponse,
    query: S.LocationsMultiQuery,
    notFound: true,
  },
  {
    path: '/leaderboards/gains',
    operationId: 'getGainsLeaderboards',
    tag: 'Leaderboards',
    summary: 'Gains leaderboards',
    description:
      'The guild page’s gains leaderboards over the accounts whose `stats` the key may read: the top 10 per skill. Default `period=day`.',
    response: S.LeaderboardsResponse,
    query: S.LeaderboardQuery,
  },
  {
    path: '/leaderboards/loot',
    operationId: 'getLootLeaderboard',
    tag: 'Leaderboards',
    summary: 'Loot leaderboard',
    description: `The period’s most valuable drops over the accounts whose \`events\` the key may read: \`loot\` and \`pk_loot\` events with a value, not on a special world, highest \`value_gp\` first. Each entry’s \`event\` is exactly what \`/events\` serves (with \`data.location\` removed the same way), though it can appear here a few seconds before the \`/events\` cursor serves it. Default \`period=day\`, \`limit=${LOOT_LEADERBOARD_DEFAULT_LIMIT}\` (at most ${LOOT_LEADERBOARD_MAX_LIMIT}).`,
    response: S.LootLeaderboardResponse,
    query: S.LootLeaderboardQuery,
  },
];

/** The public operation serving this document (no key, no rate limit). */
const OPENAPI_PATH = '/openapi.json';

/** Shapes several responses nest: each becomes a `$ref` under components.schemas. */
const SHARED_COMPONENTS: readonly [string, z.ZodType][] = [
  ['AccountRef', S.AccountRef],
  ['Owner', S.Owner],
  ['AccountLocations', S.AccountLocations],
  ['Item', S.Item],
  ['Meter', S.Meter],
  ['Skill', S.Skill],
  ['Skills', S.Skills],
  ['Items', S.Items],
  ['AccountSummary', S.AccountSummary],
  ['AccountDetail', S.AccountDetail],
  ['SnapshotAccount', S.SnapshotAccount],
  ['SnapshotLocation', S.SnapshotLocation],
  ['XpSeries', S.XpSeries],
  ['Event', S.Event],
];

const SCHEMA_NAMES = new Map<unknown, string>(
  Object.entries(S).map(([name, schema]): [unknown, string] => [schema, name]),
);

/** A response envelope's name under components.schemas: the name schemas.ts exports it by. */
function componentName(schema: z.ZodType): string {
  const name = SCHEMA_NAMES.get(schema);
  if (name === undefined) {
    throw new Error('openapi: an operation’s response must be a schema exported by schemas.ts');
  }
  return name;
}

/**
 * Everything under components.schemas: the shared shapes, every operation's response envelope (in
 * OPERATIONS order) and the error body.
 */
function components(): [string, z.ZodType][] {
  return [
    ...SHARED_COMPONENTS,
    ...OPERATIONS.map((op): [string, z.ZodType] => [componentName(op.response), op.response]),
    ['Error', S.ErrorResponse],
  ];
}

type Json = Record<string, unknown>;

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

/**
 * Drops noise zod adds that says nothing to a consumer: the long regexes behind `format: date-time`,
 * `date` and `uuid`, and the ±2^53 bounds of every integer. Also drops `additionalProperties: false`
 * from response objects: v1 grows additively (D-71), so clients must accept keys they don't know.
 */
function tidy(node: unknown, response: boolean): unknown {
  if (Array.isArray(node)) return node.map((n) => tidy(n, response));
  if (typeof node !== 'object' || node === null) return node;
  const out: Json = {};
  for (const [key, value] of Object.entries(node as Json)) out[key] = tidy(value, response);
  if (out.format === 'date-time' || out.format === 'date' || out.format === 'uuid') {
    delete out.pattern;
  }
  if (out.minimum === -MAX_SAFE) delete out.minimum;
  if (out.maximum === MAX_SAFE) delete out.maximum;
  if (response && out.additionalProperties === false) delete out.additionalProperties;
  return out;
}

function componentSchemas(): Record<string, Json> {
  const registry = z.registry<{ id: string }>();
  for (const [id, schema] of components()) registry.add(schema, { id });
  const { schemas } = z.toJSONSchema(registry, {
    target: 'draft-2020-12',
    io: 'output',
    uri: (id) => `#/components/schemas/${id}`,
  });
  const out: Record<string, Json> = {};
  for (const [id, schema] of Object.entries(schemas)) {
    const { $schema: _s, $id: _i, ...rest } = schema as Json;
    out[id] = tidy(rest, true) as Json;
  }
  return out;
}

/** OpenAPI parameter objects from a zod object of string parameters (input side). */
function parameters(schema: z.ZodObject, where: 'query' | 'path'): Json[] {
  const json = tidy(z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input' }), false) as {
    properties?: Record<string, Json>;
    required?: string[];
  };
  const required = new Set(json.required ?? []);
  return Object.entries(json.properties ?? {}).map(([name, property]) => {
    const { description, example, ...rest } = property;
    const param: Json = {
      name,
      in: where,
      required: where === 'path' || required.has(name),
      schema: rest,
    };
    if (description !== undefined) param.description = description;
    if (example !== undefined) param.example = example;
    return param;
  });
}

const RATE_HEADERS = {
  'X-RateLimit-Limit': { $ref: '#/components/headers/X-RateLimit-Limit' },
  'X-RateLimit-Remaining': { $ref: '#/components/headers/X-RateLimit-Remaining' },
  'X-RateLimit-Reset': { $ref: '#/components/headers/X-RateLimit-Reset' },
};

const ERROR_CONTENT = {
  'application/json': { schema: { $ref: '#/components/schemas/Error' } },
};

function errorResponse(description: string, headers: Json = {}): Json {
  return { description, headers, content: ERROR_CONTENT };
}

function operation(op: OperationSpec): Json {
  const params: Json[] = [];
  if (op.accountPath) params.push(...parameters(S.AccountPath, 'path'));
  if (op.query) params.push(...parameters(op.query, 'query'));
  const responses: Json = {
    '200': {
      description: 'OK: `{ data, meta }`.',
      headers: op.conditional
        ? {
            ETag: { $ref: '#/components/headers/ETag' },
            'Last-Modified': { $ref: '#/components/headers/Last-Modified' },
            ...RATE_HEADERS,
          }
        : RATE_HEADERS,
      content: {
        'application/json': {
          schema: { $ref: `#/components/schemas/${componentName(op.response)}` },
        },
      },
    },
  };
  if (op.conditional) {
    responses['304'] = {
      description:
        'Not Modified: `If-None-Match` matched the current ETag. No body; the ETag, CORS and rate-limit headers are sent.',
      headers: { ETag: { $ref: '#/components/headers/ETag' }, ...RATE_HEADERS },
    };
  }
  if (params.length > 0) responses['400'] = { $ref: '#/components/responses/BadRequest' };
  responses['401'] = { $ref: '#/components/responses/Unauthorized' };
  if (op.notFound) responses['404'] = { $ref: '#/components/responses/NotFound' };
  responses['429'] = { $ref: '#/components/responses/TooManyRequests' };
  responses['503'] = { $ref: '#/components/responses/Unavailable' };
  return {
    operationId: op.operationId,
    tags: [op.tag],
    summary: op.summary,
    description: op.description,
    security: [{ bearerAuth: [] }],
    ...(params.length > 0 ? { parameters: params } : {}),
    responses,
  };
}

const DESCRIPTION = `Read-only JSON API of this hub: OSRS account data sent by the HA Exporter RuneLite plugin, for Home Assistant, a Discord bot, a live map or your own scripts. Pull only: poll \`/snapshot\` and the \`/events\` cursor feed; there are no webhooks.

## Authentication
Create a key on the hub's **API keys** page and send it on every request:

    Authorization: Bearer ohub_<prefix>_<secret>

A key is shown once. It reads only the categories chosen for it (stats, events, activity, live location, location history, equipment, inventory), only its account scope (every account its creator can see, or an explicit list), and only what its creator may see **right now**: the owners' sharing settings are evaluated on every request. A missing, malformed, unknown, revoked or expired key, or one whose creator left the guild, gets the same \`401 unauthorized\`. Cookies are never read.

**Service keys** (Admin → Integrations) are for the guild's own integrations, such as its live map. A service key belongs to no user: it reads what the guild audience sees, i.e. the accounts and categories whose sharing audience is *guild* (never *private* or *selected*), it survives every offboarding, and it has its own rate limit (${SERVICE_KEY_RATE_LIMIT} requests per minute unless the admin set another). Only service keys see \`account_hash\`, and they may name ${MAX_BULK_ACCOUNTS_SERVICE} accounts per bulk request instead of ${MAX_BULK_ACCOUNTS}. \`/me\` tells the kinds apart (\`key.kind\`, \`user\` null).

## Owner identity
Accounts carry \`owner\` (\`{ name, discord_id }\`): the account's owner as the hub's guild page shows them to every member, or null when the account has no active owner. Contributors are never exposed.

## Conventions
- Success: \`{ "data": …, "meta": { "generated_at": …, … } }\`. Lists carry \`meta.count\`.
- Errors: \`{ "error": { "code": "…", "message": "…" } }\`, plus \`details\` (field errors) on a 400.
- Every key the hub defines is snake_case. Keys that are data (skill names such as \`Attack\`, equipment slots, item and account names) and an event's \`data\` object are passed through as they are.
- Timestamps are ISO-8601 UTC; ids are opaque public ids (strings).
- Query lists are comma-separated (\`skills=attack,defence\`); dates are ISO-8601 date-times with \`Z\` or an offset; unknown query parameters are ignored.
- v1 only changes additively: new fields and endpoints may appear, so ignore keys you don't know.

## Not found versus not shared
Anything outside the key's reach answers **404 \`not_found\`** with exactly the body of an id that doesn't exist: an unknown account, one outside the key's scope, and one whose category the key can't read all look alike, so the API never reveals what exists. On \`/accounts/{id}\` and \`/snapshot\`, a section of a category the key can't read on that account is **omitted**; a section the key may read but the player's plugin never sent is \`{ "shared": false, "updated_at": null }\` (\`/accounts/{id}\`) or \`null\` (\`/snapshot\`). The plugin is the first privacy layer: the hub stores only what arrives.

## Staleness
A live location older than 2 minutes has \`stale: true\`: the player may be elsewhere now.

## The events cursor
\`/events\` is a cursor feed: start with \`cursor=now\` (or without a cursor for the newest events), then always pass the previous \`meta.next_cursor\`. Cursors are opaque strings and only move forward. The feed serves events stored at least ${SECONDS(API_EVENTS_SETTLE_MS)} s ago, so a cursor never skips one that is still being committed: expect an event 10–15 s after it happened.

With \`from\`/\`to\`, \`/events\` reads a time range instead: the events that occurred in it, newest first, a page at a time until \`meta.next_cursor\` is null.

## Rate limits
Per key: ${API_RATE_LIMIT} requests per sliding ${SECONDS(API_RATE_WINDOW_MS)} s for a user key (a service key: ${SERVICE_KEY_RATE_LIMIT}, or the limit its admin set; \`/me\` reports it), and ${SNAPSHOT_RATE_LIMIT} request per ${SECONDS(SNAPSHOT_RATE_WINDOW_MS)} s on \`/snapshot\` for every key. Every authenticated response carries \`X-RateLimit-Limit\`, \`X-RateLimit-Remaining\` and \`X-RateLimit-Reset\` (seconds until the window frees a request: a delta, not a timestamp). Over a limit: \`429 rate_limited\` with an integer \`Retry-After\` in seconds. Failed authentications are limited to ${FAILED_AUTH_LIMIT} per ${SECONDS(FAILED_AUTH_WINDOW_MS)} s per client IP; past that, every request from that IP gets 429 until the window passes.

## CORS
Every response, errors included, has \`Access-Control-Allow-Origin: *\` and exposes \`ETag\`, \`Retry-After\` and the \`X-RateLimit-*\` headers, so browser apps can call the API directly. No credentials: send the key in the Authorization header.

## Caching
Responses are \`Cache-Control: no-store\`, except \`/snapshot\` (\`private, no-cache\` with a weak ETag; \`If-None-Match\` → 304) and this document (\`public, max-age=300\`).

## Errors
400 \`invalid_request\` (a malformed parameter; \`details\` names it), 401 \`unauthorized\`, 404 \`not_found\`, 429 \`rate_limited\` (+ \`Retry-After\`), 503 \`unavailable\` (the hub is busy or its database is unreachable; retry after \`Retry-After\`), 500 \`internal_error\`.`;

/** The whole document. `servers` is APP_URL's origin + /api/v1 (NEXT-2). */
export function buildOpenApiDocument(): Json {
  const { appOrigin, hubName } = getConfig();
  const paths: Record<string, Json> = {};
  for (const op of OPERATIONS) paths[op.path] = { get: operation(op) };
  paths[OPENAPI_PATH] = {
    get: {
      operationId: 'getOpenApi',
      tags: ['Meta'],
      summary: 'This document',
      description: 'The OpenAPI 3.1 description of API v1. Public: no key, no rate limit.',
      security: [],
      responses: {
        '200': {
          description: 'The OpenAPI document.',
          content: { 'application/json': { schema: { type: 'object' } } },
        },
      },
    },
  };

  const integer = { type: 'integer', minimum: 0 };
  return {
    openapi: '3.1.0',
    info: {
      title: 'osrs-data-hub API',
      version: '1',
      summary: `The public, read-only API of ${hubName}.`,
      description: DESCRIPTION,
    },
    servers: [{ url: `${appOrigin}/api/v1`, description: hubName }],
    security: [{ bearerAuth: [] }],
    tags: [
      { name: 'Key', description: 'The key itself.' },
      { name: 'Accounts', description: 'Visible accounts and their current state.' },
      { name: 'Snapshot', description: 'Everything at once, for polling.' },
      { name: 'XP and gains', description: 'XP series and gains (`stats`).' },
      { name: 'Events', description: 'The cursor feed and time-range reads (`events`).' },
      { name: 'Histories', description: 'Sessions, equipment, wealth and locations.' },
      {
        name: 'Leaderboards',
        description: 'Gains leaderboards (`stats`) and the loot leaderboard (`events`).',
      },
      { name: 'Meta', description: 'This document.' },
    ],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'ohub_<prefix>_<secret>',
          description: 'An API key from the hub’s API keys page.',
        },
      },
      schemas: componentSchemas(),
      headers: {
        'X-RateLimit-Limit': {
          description: `Requests allowed for this key per sliding ${SECONDS(API_RATE_WINDOW_MS)} s (${API_RATE_LIMIT} for a user key; a service key’s own limit).`,
          schema: integer,
        },
        'X-RateLimit-Remaining': {
          description: 'Requests left in the current window, this one counted.',
          schema: integer,
        },
        'X-RateLimit-Reset': {
          description:
            'Seconds (a delta, not a timestamp) until the oldest request in the window expires and Remaining goes up again; 0 when nothing is counted.',
          schema: integer,
        },
        'Retry-After': {
          description: 'Whole seconds to wait before retrying.',
          schema: { type: 'integer', minimum: 1 },
        },
        ETag: {
          description: 'Weak entity tag of this snapshot for this key; send it as If-None-Match.',
          schema: { type: 'string' },
        },
        'Last-Modified': {
          description:
            'HTTP date of the newest change among the accounts whose `activity` the key reads (absent when it reads none).',
          schema: { type: 'string' },
        },
        'WWW-Authenticate': { description: '`Bearer`.', schema: { type: 'string' } },
      },
      responses: {
        BadRequest: errorResponse(
          '`invalid_request`: a parameter is malformed or out of range; `details` names it.',
          RATE_HEADERS,
        ),
        Unauthorized: errorResponse(
          '`unauthorized`: the key is missing, malformed, unknown, revoked or expired, or its creator is no longer an active member. Always the same body.',
          { 'WWW-Authenticate': { $ref: '#/components/headers/WWW-Authenticate' } },
        ),
        NotFound: errorResponse(
          '`not_found`: the account doesn’t exist or isn’t readable with this key (the two are indistinguishable).',
          RATE_HEADERS,
        ),
        TooManyRequests: errorResponse(
          '`rate_limited`: over a per-key limit (with the X-RateLimit-* headers) or, before authentication, the client IP’s failed-authentication limit.',
          { 'Retry-After': { $ref: '#/components/headers/Retry-After' }, ...RATE_HEADERS },
        ),
        Unavailable: errorResponse(
          '`unavailable`: the hub is busy or its database is unreachable; retry after Retry-After.',
          { 'Retry-After': { $ref: '#/components/headers/Retry-After' } },
        ),
      },
    },
  };
}
