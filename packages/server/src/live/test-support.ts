/**
 * Test helpers for the live tests (not exported from the package).
 */
import { randomUUID } from 'node:crypto';
import { DEFAULT_TOAST_FILTER, type Category, type ToastFilter, type Viewer } from '@hub/core';
import {
  accountLinks,
  accountShareGrants,
  accountSharing,
  devices,
  events,
  latestState,
  osrsAccounts,
  users,
  type Db,
  type DbOrTx,
  type UserStatus,
} from '@hub/db';
import pino, { type Logger } from 'pino';
import type { LiveSubscriber } from './hub';
import type { SseEventName } from './sse';

let n = 0;

export async function seedUser(
  db: Db,
  opts: { name?: string; status?: UserStatus; isAdmin?: boolean } = {},
): Promise<Viewer & { name: string }> {
  const id = `live-user-${++n}-${randomUUID().slice(0, 8)}`;
  const name = opts.name ?? `User ${n}`;
  const status = opts.status ?? 'active';
  const isAdmin = opts.isAdmin ?? false;
  await db.insert(users).values({ id, name, email: `${id}@discord.invalid`, status, isAdmin });
  return { userId: id, name, status, isAdmin };
}

export interface SeededAccount {
  id: number;
  publicId: string;
  name: string;
}

export async function seedAccount(
  db: Db,
  opts: {
    name: string;
    ownerUserId?: string | null;
    accountType?: number | null;
    status?: 'active' | 'hidden';
  },
): Promise<SeededAccount> {
  const publicId = randomUUID().replace(/-/g, '').slice(0, 12);
  const [row] = await db
    .insert(osrsAccounts)
    .values({
      publicId,
      accountHash: randomUUID(),
      currentName: opts.name,
      nameNormalized: opts.name.toLowerCase(),
      accountType: opts.accountType ?? null,
      ownerUserId: opts.ownerUserId ?? null,
      status: opts.status ?? 'active',
    })
    .returning({ id: osrsAccounts.id });
  if (!row) throw new Error('seedAccount: no row');
  if (opts.ownerUserId) await link(db, row.id, opts.ownerUserId, 'owner');
  return { id: row.id, publicId, name: opts.name };
}

export async function link(
  db: Db,
  accountId: number,
  userId: string,
  role: 'owner' | 'contributor' = 'contributor',
  blocked = false,
): Promise<void> {
  await db.insert(accountLinks).values({ accountId, userId, role, blocked });
}

export async function share(
  db: Db,
  accountId: number,
  category: Category,
  audience: 'private' | 'guild' | 'selected',
): Promise<void> {
  await db
    .insert(accountSharing)
    .values({ accountId, category, audience })
    .onConflictDoUpdate({
      target: [accountSharing.accountId, accountSharing.category],
      set: { audience },
    });
}

export async function grant(
  db: Db,
  accountId: number,
  category: Category,
  granteeUserId: string,
): Promise<void> {
  await db.insert(accountShareGrants).values({ accountId, category, granteeUserId });
}

export async function seedDevice(db: Db, userId: string): Promise<string> {
  const [row] = await db
    .insert(devices)
    .values({ userId, tokenHash: randomUUID() })
    .returning({ id: devices.id });
  if (!row) throw new Error('seedDevice: no row');
  return row.id;
}

export interface SeedEventOptions {
  type?: string;
  occurredAt: Date;
  receivedAt?: Date;
  insertedAt?: Date;
  valueGp?: number | null;
  data?: Record<string, unknown>;
}

/** Inserts an event; returns its id and seq. Seed in receive order (replay relies on it). */
export async function seedEvent(
  db: DbOrTx,
  accountId: number,
  opts: SeedEventOptions,
): Promise<{ id: string; seq: number }> {
  const type = opts.type ?? 'loot';
  const [row] = await db
    .insert(events)
    .values({
      pluginEventId: randomUUID(),
      accountId,
      type,
      occurredAt: opts.occurredAt,
      receivedAt: opts.receivedAt ?? opts.occurredAt,
      ...(opts.insertedAt ? { insertedAt: opts.insertedAt } : {}),
      valueGp: opts.valueGp ?? null,
      data: opts.data ?? { type, data: {}, eventId: randomUUID(), timestamp: 0 },
    })
    .returning({ id: events.id, seq: events.seq });
  if (!row) throw new Error('seedEvent: no row');
  return row;
}

/** A death event's stored data, with coordinates (redacted for viewers without location). */
export function deathData(): Record<string, unknown> {
  return {
    type: 'death',
    data: {
      valueLost: 34906,
      danger: 'DANGEROUS',
      killerName: 'Lynx Titan',
      location: { x: 3068, y: 3858, plane: 0 },
    },
    eventId: randomUUID(),
    timestamp: 0,
  };
}

export async function seedLatestState(
  db: Db,
  accountId: number,
  values: Partial<typeof latestState.$inferInsert> & { lastSeen: Date },
): Promise<void> {
  await db.insert(latestState).values({ accountId, ...values });
}

export interface ParsedSse {
  id?: string;
  event: SseEventName;
  data: unknown;
}

/** Splits SSE text into messages (comments and retry lines are skipped). */
export function parseSse(text: string): ParsedSse[] {
  const out: ParsedSse[] = [];
  for (const block of text.split('\n\n')) {
    const msg: Partial<ParsedSse> = {};
    for (const line of block.split('\n')) {
      if (line.startsWith('id: ')) msg.id = line.slice(4);
      else if (line.startsWith('event: ')) msg.event = line.slice(7) as SseEventName;
      else if (line.startsWith('data: ')) msg.data = JSON.parse(line.slice(6));
    }
    if (msg.event) out.push(msg as ParsedSse);
  }
  return out;
}

/** A subscriber that records what it was sent. */
export function fakeSubscriber(
  viewer: Viewer,
  toast: Partial<ToastFilter> = {},
): LiveSubscriber & { chunks: string[]; messages(event?: SseEventName): ParsedSse[] } {
  const chunks: string[] = [];
  return {
    viewer: { userId: viewer.userId, status: viewer.status, isAdmin: viewer.isAdmin },
    toast: { ...DEFAULT_TOAST_FILTER, ...toast },
    chunks,
    send(chunk: string) {
      chunks.push(chunk);
    },
    messages(event?: SseEventName) {
      const all = parseSse(chunks.join(''));
      return event ? all.filter((m) => m.event === event) : all;
    },
  };
}

/** A pino logger writing into an array. */
export function captureLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const logger = pino(
    { level: 'debug', base: null, timestamp: false },
    { write: (s: string) => void lines.push(s) },
  );
  return { logger, lines };
}
