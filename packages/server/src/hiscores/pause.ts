/**
 * The pause of every hiscores lookup after the hiscores pushed back (D-105): a 429, a 403, a 5xx, a
 * page that isn't the hiscores, or no answer. The first pause is a minute, each next one doubles up
 * to an hour, and Retry-After is honoured when it asks for longer; one clean lookup resets it. Kept
 * in the worker's memory (one worker process), so a restart starts over at a minute.
 */
const MIN_PAUSE_MS = 60_000;
const MAX_PAUSE_MS = 60 * 60_000;

export class HiscorePause {
  private until = 0;
  private lastMs = 0;

  /** When lookups may go on, or null when they may now. */
  pausedUntil(now: Date): Date | null {
    return this.until > now.getTime() ? new Date(this.until) : null;
  }

  /** Pauses after a push-back; returns the end of the pause. */
  trip(now: Date, retryAfterMs: number | null): Date {
    this.lastMs = Math.min(MAX_PAUSE_MS, Math.max(MIN_PAUSE_MS, this.lastMs * 2));
    this.until = now.getTime() + Math.max(this.lastMs, Math.min(retryAfterMs ?? 0, MAX_PAUSE_MS));
    return new Date(this.until);
  }

  /** A clean lookup: the next push-back pauses for a minute again. */
  reset(): void {
    this.lastMs = 0;
  }
}

const g = globalThis as unknown as { __hubHiscorePause?: HiscorePause };

/** The process's pause. */
export function getHiscorePause(): HiscorePause {
  g.__hubHiscorePause ??= new HiscorePause();
  return g.__hubHiscorePause;
}
