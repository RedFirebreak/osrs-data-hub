/**
 * Test harness for the ingest pipeline (imported by *.test.ts only): a real database, a controllable
 * clock shared by the request time and the rate limiter, seeded users/devices, and fixture helpers.
 */
import { randomBytes } from 'node:crypto';
import { generateDeviceToken, sha256Hex } from '@hub/core';
import { devices, osrsAccounts, users, type UserStatus } from '@hub/db';
import type { TestDatabase } from '@hub/db/testing';
import { fixtureJson, type FixtureName } from '@hub/fixtures';
import { eq } from 'drizzle-orm';
import pino from 'pino';
import type { PluginResponse } from '../feed';
import { silentLogger, type Logger } from '../logger';
import { createTestMetrics, type HubMetrics } from '../metrics';
import { handleIngest } from './handler';
import { createIngestLimiter } from './limits';
import type { IngestDeps } from './types';

/** A fixture body as a mutable object (the wire shape: strings where the plugin sends strings). */
export type Wire = Record<string, unknown> & {
  player?: Record<string, unknown> & {
    name?: string;
    accountHash?: string;
    stats?: { skills: Record<string, { xp: number; level: number }> };
  };
  events?: Record<string, unknown>[];
  timestamp?: number;
  state?: string;
};

export interface SeededDevice {
  id: string;
  userId: string;
  token: string;
}

export interface SendOptions {
  /** X-Osrs-Exporter-Version; default '1.5'. null = header missing. */
  version?: string | null;
  /** Receive time (epoch ms). Default: the body's root timestamp + 1 s, else the current clock. */
  at?: number;
  ip?: string | null;
  /** Token override (default the device's). */
  token?: string | null;
  /** readBody result override (null = too large). */
  readBody?: (maxBytes: number) => Promise<string | null>;
}

export interface Harness {
  db: TestDatabase['db'];
  deps: IngestDeps;
  metrics: HubMetrics;
  /** The clock used for recv and by the rate limiter (epoch ms). */
  clock: { now: number };
  seedUser(opts?: { status?: UserStatus }): Promise<string>;
  seedDevice(userId?: string, opts?: { revoked?: boolean }): Promise<SeededDevice>;
  send(device: SeededDevice, body: string | Wire, opts?: SendOptions): Promise<PluginResponse>;
  accountIdByHash(hash: string): Promise<number | undefined>;
}

/** Fixture timestamps are around 1790000000000 (2026-09-21). */
const DEFAULT_CLOCK = 1_790_000_000_000;

export function createHarness(t: TestDatabase, overrides: Partial<IngestDeps> = {}): Harness {
  const clock = { now: DEFAULT_CLOCK };
  const metrics = createTestMetrics();
  const deps: IngestDeps = {
    db: t.db,
    minPluginVersion: '1.5',
    maxBodyBytes: 256 * 1024,
    limiter: createIngestLimiter({ clock: { now: () => clock.now } }),
    logger: silentLogger(),
    metrics,
    isDecommissioned: () => false,
    now: () => new Date(clock.now),
    ...overrides,
  };

  const seedUser: Harness['seedUser'] = async (opts = {}) => {
    const id = `u_${randomBytes(6).toString('hex')}`;
    await t.db
      .insert(users)
      .values({ id, name: id, email: `${id}@discord.invalid`, status: opts.status ?? 'active' });
    return id;
  };

  const seedDevice: Harness['seedDevice'] = async (userId, opts = {}) => {
    const owner = userId ?? (await seedUser());
    const token = generateDeviceToken();
    const [row] = await t.db
      .insert(devices)
      .values({
        userId: owner,
        tokenHash: sha256Hex(token),
        label: 'test',
        revokedAt: opts.revoked ? new Date() : null,
        revokedReason: opts.revoked ? 'user' : null,
      })
      .returning({ id: devices.id });
    if (!row) throw new Error('device insert failed');
    return { id: row.id, userId: owner, token };
  };

  const send: Harness['send'] = async (device, body, opts = {}) => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    if (opts.at !== undefined) clock.now = opts.at;
    else if (typeof body !== 'string' && typeof body.timestamp === 'number') {
      clock.now = body.timestamp + 1_000;
    }
    return handleIngest(deps, {
      token: opts.token === undefined ? device.token : opts.token,
      versionHeader: opts.version === undefined ? '1.5' : opts.version,
      ip: opts.ip === undefined ? '203.0.113.7' : opts.ip,
      readBody:
        opts.readBody ??
        ((maxBytes) => Promise.resolve(Buffer.byteLength(text, 'utf8') > maxBytes ? null : text)),
    });
  };

  const accountIdByHash: Harness['accountIdByHash'] = async (hash) => {
    const [row] = await t.db
      .select({ id: osrsAccounts.id })
      .from(osrsAccounts)
      .where(eq(osrsAccounts.accountHash, hash));
    return row?.id;
  };

  return { db: t.db, deps, metrics, clock, seedUser, seedDevice, send, accountIdByHash };
}

/** A fresh 56-hex account hash (like the plugin's salted SHA-224). */
export function newHash(): string {
  return randomBytes(28).toString('hex');
}

/** A fresh event id. */
export function newEventId(): string {
  return crypto.randomUUID();
}

/**
 * A fixture as a mutable object, optionally re-keyed to another account (so scenarios don't share
 * the Zezima account, whose fixtures aren't XP-consistent over time) and to new event ids.
 */
export function wire(
  name: FixtureName,
  opts: { hash?: string; name?: string; freshEventIds?: boolean } = {},
): Wire {
  const body = fixtureJson<Wire>(name);
  if (body.player) {
    if (opts.hash !== undefined) body.player.accountHash = opts.hash;
    if (opts.name !== undefined) body.player.name = opts.name;
  }
  if (opts.freshEventIds) {
    for (const e of body.events ?? []) e.eventId = newEventId();
  }
  return body;
}

/** Sum of min(level, 99) over a wire body's skills (the real total level, D-44). */
export function realTotalLevel(body: Wire): number {
  const skills = body.player?.stats?.skills ?? {};
  return Object.values(skills).reduce((sum, s) => sum + Math.min(s.level, 99), 0);
}

/** A logger that records every line (as parsed JSON) for assertions. */
export function captureLogger(): { logger: Logger; lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  const logger = pino(
    { level: 'debug' },
    {
      write(line: string) {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
  );
  return { logger, lines };
}

/** The value of a counter for the given labels (0 when never incremented). */
export async function counterValue(
  counter: { get(): Promise<{ values: { labels: Record<string, unknown>; value: number }[] }> },
  labels: Record<string, string> = {},
): Promise<number> {
  const { values } = await counter.get();
  const match = values.find((v) =>
    Object.entries(labels).every(([k, want]) => String(v.labels[k]) === want),
  );
  return match?.value ?? 0;
}
