/**
 * Payloads of the live stream's messages (the `data` of each SSE message, see sse.ts). The browser
 * parses them from JSON, so every Date is an ISO-8601 string.
 */
import { shouldToast, type ResolvedAccess, type ToastFilter } from '@hub/core';
import type { FeedEvent } from '../feed';
import type { DeviceFirstData } from '../pairing/codes';

/** Payload of an 'event' message (and of each replayed event). */
export interface LiveEventMessage {
  event: FeedEvent;
  /** Whether the client shows a toast; the feed shows the event either way. */
  toast: boolean;
}

/** Payload of a 'presence' message (viewers with the `activity` category). */
export interface PresenceMessage {
  account: { publicId: string; name: string; accountType: number | null };
  online: boolean;
  world: number | null;
  specialWorld: boolean;
  /** ISO-8601 UTC. */
  lastSeen: string;
  /**
   * How much longer `online` stays true without another message (0 when offline): nothing is sent
   * when presence times out (a crash, a lost connection or a hop to a special world just stops the
   * payloads), so the client marks the account offline this long after receiving the message.
   * Relative, so the browser's clock doesn't matter.
   */
  onlineForMs: number;
}

/** Payload of a 'pairing' message (the wizard's step 2), sent only to the code's user. */
export type PairingMessage =
  | { kind: 'consumed'; codeId: string; deviceId: string }
  | { kind: 'outdated_plugin'; codeId: string; version: string | null };

/**
 * Payload of a 'device' message: the first data from one of the viewer's own devices (the wizard's
 * step 3). Same shape as the polling fallback getDeviceFirstData, plus the device id.
 */
export interface DeviceMessage extends DeviceFirstData {
  deviceId: string;
}

/**
 * The 'event' payload for one viewer: the (already redacted) event and the viewer's toast flag
 * (@hub/core shouldToast). "Own account" means owner or non-blocked contributor, as resolveAccess
 * decided the relation.
 */
export function toEventMessage(
  event: FeedEvent,
  filter: ToastFilter,
  access: Pick<ResolvedAccess, 'relation'>,
  now: Date,
): LiveEventMessage {
  const toast = shouldToast(
    { type: event.type, valueGp: event.valueGp, occurredAt: new Date(event.occurredAt) },
    filter,
    { isOwnAccount: access.relation === 'owner' || access.relation === 'contributor', now },
  );
  return { event, toast };
}
