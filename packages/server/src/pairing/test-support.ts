/**
 * Test helpers shared by the pairing, devices and settings tests (not exported from the package).
 */
import { randomUUID } from 'node:crypto';
import type { Clock } from '@hub/core';
import { deviceAccounts, devices, osrsAccounts, users, type Db, type UserStatus } from '@hub/db';
import pg from 'pg';
import pino, { type Logger } from 'pino';

export class FakeClock implements Clock {
  constructor(public t = Date.parse('2026-09-28T12:00:00Z')) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
  date(): Date {
    return new Date(this.t);
  }
}

let seq = 0;

/** Inserts a user; returns its id. */
export async function seedUser(
  db: Db,
  opts: { name?: string; status?: UserStatus; isAdmin?: boolean } = {},
): Promise<string> {
  const id = `user-${++seq}-${randomUUID().slice(0, 8)}`;
  await db.insert(users).values({
    id,
    name: opts.name ?? `User ${seq}`,
    email: `${id}@discord.invalid`,
    status: opts.status ?? 'active',
    isAdmin: opts.isAdmin ?? false,
  });
  return id;
}

/** Inserts a device (token hash random); returns its id. */
export async function seedDevice(
  db: Db,
  userId: string,
  values: Partial<typeof devices.$inferInsert> = {},
): Promise<string> {
  const [row] = await db
    .insert(devices)
    .values({ userId, tokenHash: randomUUID(), ...values })
    .returning({ id: devices.id });
  if (!row) throw new Error('seedDevice: no row');
  return row.id;
}

/** Inserts an OSRS account; returns its id and public id. */
export async function seedAccount(
  db: Db,
  opts: { name: string; ownerUserId?: string | null; accountType?: number | null },
): Promise<{ id: number; publicId: string }> {
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
    })
    .returning({ id: osrsAccounts.id });
  if (!row) throw new Error('seedAccount: no row');
  return { id: row.id, publicId };
}

export async function linkDeviceAccount(
  db: Db,
  deviceId: string,
  accountId: number,
  times: { firstSeen: Date; lastSeen?: Date },
): Promise<void> {
  await db.insert(deviceAccounts).values({
    deviceId,
    accountId,
    firstSeen: times.firstSeen,
    lastSeen: times.lastSeen ?? times.firstSeen,
  });
}

/** A LISTEN connection that collects the JSON payloads of one channel. */
export async function listen(url: string, channel: string) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const messages: unknown[] = [];
  client.on('notification', (m) => {
    if (m.channel === channel && m.payload) messages.push(JSON.parse(m.payload));
  });
  await client.query(`LISTEN ${channel}`);
  return {
    messages,
    /** Waits until at least `count` messages arrived (or `timeoutMs` passed). */
    async waitFor(count: number, timeoutMs = 2_000): Promise<unknown[]> {
      const deadline = Date.now() + timeoutMs;
      while (messages.length < count && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      return messages;
    },
    /** Round trip on the listener connection: every notification committed before is delivered. */
    async flush(): Promise<void> {
      await client.query('SELECT 1');
    },
    close: () => client.end(),
  };
}

/** A pino logger writing into an array (to assert what is, and isn't, logged). */
export function captureLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  // No pid, hostname or time: they would add digits that could contain a 5-digit code by chance.
  const logger = pino(
    { level: 'debug', base: null, timestamp: false },
    { write: (s: string) => void lines.push(s) },
  );
  return { logger, lines };
}
