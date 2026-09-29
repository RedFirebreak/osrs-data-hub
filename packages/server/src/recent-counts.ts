/**
 * Counts per minute and key over a short recent window, in memory. Ingest uses it for the responses
 * whose body was never archived (401, 410, 413, 429, an outdated plugin, D-83), so the ingest health
 * chart can show them next to the archived payloads. Like the Prometheus counters it lives in one
 * process (on globalThis through getMetrics, NEXT-3) and starts empty when the process restarts.
 */

const MINUTE_MS = 60_000;

/** A count per key for one minute. */
export interface RecentMinute {
  /** Start of the minute. */
  minute: Date;
  total: number;
  byKey: Record<string, number>;
}

export class RecentMinuteCounts {
  /** Minute start (epoch ms) → key → count. At most `keepMinutes` + 1 minutes are held. */
  private readonly minutes = new Map<number, Map<string, number>>();

  constructor(private readonly keepMinutes: number) {}

  /** Counts one `key` in the minute of `at`, and forgets minutes that fell out of the window. */
  add(key: string, at: Date): void {
    const minute = minuteStart(at.getTime());
    if (!Number.isFinite(minute)) return;
    let counts = this.minutes.get(minute);
    if (!counts) {
      counts = new Map();
      this.minutes.set(minute, counts);
      this.prune(minute);
    }
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  /**
   * The last `minutes` minutes up to and including the one of `now`, oldest first, zero-filled
   * (the same windows as the ingest health series). `minutes` is capped at the window kept.
   */
  series(now: Date, minutes: number): RecentMinute[] {
    const count = Math.max(0, Math.min(minutes, this.keepMinutes));
    const last = minuteStart(now.getTime());
    return Array.from({ length: count }, (_, i) => {
      const start = last - (count - 1 - i) * MINUTE_MS;
      const counts = this.minutes.get(start);
      const byKey: Record<string, number> = {};
      let total = 0;
      for (const [key, n] of counts ?? []) {
        byKey[key] = n;
        total += n;
      }
      return { minute: new Date(start), total, byKey };
    });
  }

  /** Drops minutes older than the window that ends at `newest`. */
  private prune(newest: number): void {
    const oldest = newest - this.keepMinutes * MINUTE_MS;
    for (const minute of this.minutes.keys()) {
      if (minute < oldest) this.minutes.delete(minute);
    }
  }
}

function minuteStart(ms: number): number {
  return Math.floor(ms / MINUTE_MS) * MINUTE_MS;
}
