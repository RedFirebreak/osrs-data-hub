/**
 * Postgres LISTEN/NOTIFY channels used for fan-out from ingest/pairing to the SSE streams (D-5).
 * `pg_notify` is called INSIDE the writing transaction: it is delivered on commit only and never on
 * rollback. Payloads must stay under 8000 bytes, so they carry ids, not data.
 */
import { sql } from 'drizzle-orm';
import type { DbOrTx } from '@hub/db';

export const CHANNELS = {
  events: 'hub_events',
  state: 'hub_state',
  pairing: 'hub_pairing',
} as const;
export type Channel = (typeof CHANNELS)[keyof typeof CHANNELS];

/** New events were committed for an account. */
export interface EventsNotification {
  accountId: number;
  seqs: number[];
}

/** An account's live state changed (presence, world, …). */
export interface StateNotification {
  accountId: number;
  deviceId: string | null;
  /** First payload with an account from this device (the wizard's "receiving data for …"). */
  firstDataForDevice?: boolean;
}

/** Pairing progress for the wizard of the user who created the code. */
export type PairingNotification =
  | { kind: 'consumed'; userId: string; codeId: string; deviceId: string }
  | { kind: 'outdated_plugin'; userId: string; codeId: string; version: string | null };

const MAX_SEQS_PER_NOTIFY = 400;

export async function notifyEvents(tx: DbOrTx, n: EventsNotification): Promise<void> {
  // Keep the payload well below the 8000-byte NOTIFY limit.
  for (let i = 0; i < n.seqs.length; i += MAX_SEQS_PER_NOTIFY) {
    const payload: EventsNotification = {
      accountId: n.accountId,
      seqs: n.seqs.slice(i, i + MAX_SEQS_PER_NOTIFY),
    };
    await tx.execute(sql`SELECT pg_notify(${CHANNELS.events}, ${JSON.stringify(payload)})`);
  }
}

export async function notifyState(tx: DbOrTx, n: StateNotification): Promise<void> {
  await tx.execute(sql`SELECT pg_notify(${CHANNELS.state}, ${JSON.stringify(n)})`);
}

export async function notifyPairing(tx: DbOrTx, n: PairingNotification): Promise<void> {
  await tx.execute(sql`SELECT pg_notify(${CHANNELS.pairing}, ${JSON.stringify(n)})`);
}
