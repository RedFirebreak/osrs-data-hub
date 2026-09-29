/**
 * The one event shape the UI and the live stream use. Built from an `events` row after the viewer's
 * permissions are known: `data` is redacted (@hub/core redactEventData) and the description is
 * computed from the redacted data, so nothing hidden leaks through the text either.
 */
import { describeEvent, redactEventData, type Category } from '@hub/core';

/** The columns of an `events` row that a feed needs. */
export interface EventRowLike {
  id: string;
  seq: number;
  type: string;
  occurredAt: Date;
  receivedAt: Date;
  valueGp: number | null;
  itemId: number | null;
  npcId: number | null;
  skill: string | null;
  level: number | null;
  tier: string | null;
  points: number | null;
  specialWorld: boolean;
  data: unknown;
}

export interface FeedEvent {
  /** Public event id (uuid v7). */
  id: string;
  /** Cursor (SSE `id:`, polling `after=`). */
  seq: number;
  type: string;
  account: { publicId: string; name: string };
  /** ISO-8601 UTC. */
  occurredAt: string;
  receivedAt: string;
  valueGp: number | null;
  itemId: number | null;
  npcId: number | null;
  skill: string | null;
  level: number | null;
  tier: string | null;
  points: number | null;
  specialWorld: boolean;
  /** The stored original event, redacted for this viewer. */
  data: unknown;
  title: string;
  line: string;
  /** lucide-react icon hint from describeEvent. */
  icon: string;
}

export function toFeedEvent(
  row: EventRowLike,
  account: { publicId: string; name: string },
  categories: ReadonlySet<Category>,
): FeedEvent {
  const data = redactEventData(row.type, row.data, categories);
  const d = describeEvent(account.name, { ...row, data });
  return {
    id: row.id,
    seq: row.seq,
    type: row.type,
    account,
    occurredAt: row.occurredAt.toISOString(),
    receivedAt: row.receivedAt.toISOString(),
    valueGp: row.valueGp,
    itemId: row.itemId,
    npcId: row.npcId,
    skill: row.skill,
    level: row.level,
    tier: row.tier,
    points: row.points,
    specialWorld: row.specialWorld,
    data,
    title: d.title,
    line: d.line,
    icon: d.icon,
  };
}

/** Plugin endpoint response (route handlers turn it into a Response). */
export interface PluginResponse {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
}
