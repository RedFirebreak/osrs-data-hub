/**
 * JSON logs to stdout (pino). No transports: they break in the bundled worker (TOOL-4); pipe through
 * `pino-pretty` locally if wanted. Logs never contain tokens or location data (handoff §16): the
 * redact paths below are a safety net; callers must not log payload bodies or DB error messages
 * (DB-3), only codes and counts.
 */
import { logLevelFromEnv } from '@hub/core';
import pino, { type Logger } from 'pino';

export type { Logger };

const REDACT = [
  'token',
  '*.token',
  'headers["x-osrs-token"]',
  'headers.authorization',
  'headers.cookie',
  'authorization',
  'cookie',
  'location',
  '*.location',
  'locationTrail',
  '*.locationTrail',
  'locationPoints',
  '*.locationPoints',
  'body',
  '*.body',
  'accessToken',
  '*.accessToken',
  'refreshToken',
  'botToken',
];

const g = globalThis as unknown as { __hubLogger?: Logger };

export function getLogger(): Logger {
  g.__hubLogger ??= pino({
    // Not getConfig().logLevel: the logger is created first, to report an invalid configuration.
    level: logLevelFromEnv(process.env.LOG_LEVEL),
    base: { service: process.env.HUB_SERVICE ?? 'hub' },
    redact: { paths: REDACT, censor: '[redacted]' },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
  return g.__hubLogger;
}

/** A logger that discards everything (tests). */
export function silentLogger(): Logger {
  return pino({ level: 'silent' });
}
