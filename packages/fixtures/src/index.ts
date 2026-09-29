/**
 * HA Exporter v1.5 payload fixtures (wire-exact, anonymized). See ../README.md for what each file is
 * and which plugin code path produces it.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const PAYLOAD_DIR = path.join(import.meta.dirname, '..', 'payloads');
const HTTP_DIR = path.join(import.meta.dirname, '..', 'http');

export const FIXTURES = [
  'disabled-login-screen',
  'event-collectionlog-unresolved',
  'event-collectionlog',
  'event-combattask',
  'event-death-dangerous',
  'event-death-safe',
  'event-diary-repeat',
  'event-levelup-multi',
  'event-loot',
  'event-pkloot',
  'event-superior',
  'event-unknown-type',
  'hop-from-special-world-stale',
  'login-partial-player',
  'logout-client-start-no-player',
  'logout',
  'pair-request',
  'retry-duplicate-a',
  'retry-duplicate-b',
  'retry-overtaking-snapshot',
  'shutdown',
  'snapshot-combat-burst-1',
  'snapshot-combat-burst-2',
  'snapshot-combat-burst-3',
  'snapshot-no-sections',
  'snapshot-normal',
  'snapshot-world-hop',
  'special-world-seasonal',
] as const;

export type FixtureName = (typeof FIXTURES)[number];

/** The exact request body as the plugin sends it (a compact JSON string, no trailing newline). */
export function fixtureBody(name: FixtureName): string {
  return readFileSync(path.join(PAYLOAD_DIR, `${name}.json`), 'utf8');
}

/** The parsed body. A fresh object on every call, so tests can mutate it. */
export function fixtureJson<T = Record<string, unknown>>(name: FixtureName): T {
  return JSON.parse(fixtureBody(name)) as T;
}

/** Raw HTTP captures (pair-request, events-request, redirect-301-downgraded-get). */
export function httpCapture(name: string): string {
  return readFileSync(path.join(HTTP_DIR, `${name}.http`), 'utf8');
}

/** Every payload file on disk, so a test can assert FIXTURES is complete. */
export function payloadFilesOnDisk(): string[] {
  return readdirSync(PAYLOAD_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length))
    .sort();
}

/** Account hashes used by the fixtures (fictional players). */
export const FIXTURE_ACCOUNTS = {
  zezima: fixtureJson<{ player: { accountHash: string } }>('snapshot-normal').player.accountHash,
  lynxTitan: fixtureJson<{ player: { accountHash: string } }>('event-pkloot').player.accountHash,
  ironMira: fixtureJson<{ player: { accountHash: string } }>('event-death-dangerous').player
    .accountHash,
} as const;
