/**
 * The hub's MCP server (D-128): one per request, for the key that made it, over the tools in
 * tools.ts, two resources and three prompts. Stateless: no session, no subscriptions, nothing changes
 * at runtime, so a client that reconnects loses nothing.
 *
 * Tool errors the model can act on (ToolError, the read models' ApiError) come back as a tool result
 * with `isError` and their message. Anything else is logged (DB-3: never the query's parameters) and
 * answered with a message that leaks nothing, the way handleApi answers a 500.
 */
import { getConfig } from '@hub/core';
import { pgErrorCode, safeDbErrorMessage, type DbOrTx } from '@hub/db';
import {
  ApiError,
  apiAccountCategories,
  apiListAccounts,
  apiMe,
  getLogger,
  type ApiPrincipal,
} from '@hub/server';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ToolError } from './resolve';
import { TOOLS, type ToolContext, type ToolResult } from './tools';

/** What hub://me lists, so a client can tell a member their hub predates a tool (D-134). */
export const MCP_FEATURES = [
  'accounts',
  'gains',
  'events',
  'event_search',
  'leaderboards',
  'hiscores',
  'collection_log',
  'who_has',
  'sessions',
  'locations',
] as const;

const INSTRUCTIONS =
  "Old School RuneScape data of one guild (clan), read through an API key: accounts, levels and XP gained, drops and other events, leaderboards, hiscores, collection logs, play sessions and where players went. Read-only. Accounts can be named by their in-game name. What the key may read on each account is in hub://accounts; an answer like \"this key can't read\" means the owner doesn't share it with the key, not that it doesn't exist. Times are UTC unless a tool says otherwise.";

function text(value: unknown): { type: 'text'; text: string } {
  return { type: 'text', text: JSON.stringify(value, null, 1) };
}

async function runTool(
  ctx: ToolContext,
  name: string,
  run: () => Promise<ToolResult>,
): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> {
  try {
    return { content: [text(await run())] };
  } catch (err) {
    if (err instanceof ToolError || err instanceof ApiError) {
      return { content: [{ type: 'text', text: err.message }], isError: true };
    }
    // DB-3: a query error's message carries its parameters; log the safe message only.
    getLogger().error(
      {
        tool: name,
        errName: err instanceof Error ? err.name : typeof err,
        pgCode: pgErrorCode(err),
        error: safeDbErrorMessage(err),
      },
      'mcp: tool failed',
    );
    return {
      content: [
        { type: 'text', text: 'The hub could not answer this right now. Try again later.' },
      ],
      isError: true,
    };
  }
}

/** hub://me: the key, what it may read, the guild and the hub's version (D-134). */
export async function readMe(db: DbOrTx, principal: ApiPrincipal) {
  const me = await apiMe(db, principal);
  const config = getConfig();
  return {
    guild: config.discord.guildName,
    hub: config.hubName,
    hub_version: config.hubVersion,
    features: MCP_FEATURES,
    key: {
      kind: me.key.kind,
      name: me.key.name,
      categories: me.key.categories,
      rate_limit_per_minute: me.key.rateLimitPerMinute,
      expires_at: me.key.expiresAt,
    },
    user: me.user?.name ?? null,
    visible_accounts: me.visibleAccounts,
  };
}

/** hub://accounts: the name → id table every tool resolves against, with what the key reads on each. */
export async function readAccounts(db: DbOrTx, principal: ApiPrincipal, now: Date) {
  const [list, categories] = await Promise.all([
    apiListAccounts(db, principal, {}, now),
    apiAccountCategories(db, principal),
  ]);
  return list.map((a) => ({
    id: a.id,
    name: a.name,
    type: a.typeLabel,
    owner: a.owner?.name ?? null,
    categories: categories.get(a.id) ?? [],
  }));
}

export function createMcpServer(db: DbOrTx, principal: ApiPrincipal, now: Date = new Date()) {
  const server = new McpServer(
    { name: 'osrs-data-hub', title: getConfig().hubName, version: getConfig().hubVersion },
    { instructions: INSTRUCTIONS },
  );
  const ctx: ToolContext = { db, principal, now };

  for (const def of TOOLS) {
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: def.input,
        annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
      },
      (args: Record<string, unknown>) => runTool(ctx, def.name, () => def.run(ctx, args as never)),
    );
  }

  server.registerResource(
    'accounts',
    'hub://accounts',
    {
      title: 'Accounts',
      description:
        'The accounts this key can see: id, name, type, owner and the categories the key may read on each. The name → id table for every tool.',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(await readAccounts(db, principal, now)),
        },
      ],
    }),
  );
  server.registerResource(
    'me',
    'hub://me',
    {
      title: 'This key',
      description:
        'The key: user or service key, its categories and rate limit, whose it is, the guild, the hub version and what this hub can answer.',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(await readMe(db, principal)),
        },
      ],
    }),
  );

  server.registerPrompt(
    'guild_today',
    {
      title: 'The guild today',
      description:
        "Who is online, the day's top XP gains, the big drops and new collection log slots.",
    },
    () => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: 'Tell me what the guild did today. Use list_accounts (who is online), leaderboard with kind=gains and period=day, recent_events from today\'s midnight with min_value=1000000 for the big drops, and recent_events with types=["collection_log"] for new log slots. Keep it short and friendly, name people, and quote GP values as the tools format them.',
          },
        },
      ],
    }),
  );
  server.registerPrompt(
    'player_day',
    {
      title: 'What did a player do',
      description:
        "A light write-up of one account's day: playtime, XP, drops and where they went.",
      argsSchema: {
        account: z.string().min(1).max(64).describe("The account's name."),
        date: z.string().max(10).optional().describe('YYYY-MM-DD; default today.'),
      },
    },
    ({ account, date }) => {
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `What did ${account} do ${date ? `on ${date}` : 'today'}? Call day_summary once (account "${account}"${date ? `, date "${date}"` : ''}). Write a few light sentences: how long they played, what they trained, notable drops or deaths, and where they spent their time. If the answer lists not_shared, leave those parts out and say so once.`,
            },
          },
        ],
      };
    },
  );
  server.registerPrompt(
    'who_has',
    {
      title: 'Who has an item',
      description: 'Who in the guild has logged an item, and when.',
      argsSchema: { item: z.string().min(2).max(64).describe("Part of the item's name.") },
    },
    ({ item }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Who in the guild has a ${item}? Use who_has with item="${item}". Answer with the holders and when they got it, and say how many accounts were searchable (only accounts that share their log can be searched).`,
          },
        },
      ],
    }),
  );

  return server;
}
