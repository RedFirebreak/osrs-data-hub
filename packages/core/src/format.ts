import { DAY_MS, HOUR_MS, MINUTE_MS } from './time';

/** What the formatters show for a missing or non-finite value. */
const NO_VALUE = '—';

const GP_UNITS = ['', 'K', 'M', 'B', 'T'] as const;
const INTEGER_FORMAT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/**
 * 38_200_000 → "38.2M", 1_500 → "1.5K", 999 → "999", 2_147_000_000 → "2.15B" (3 significant digits
 * max, rounded, trailing zeros dropped: 1_000_000 → "1M", 999_999 → "1M"). Below 1,000 the value is
 * rounded to an integer. Negative values get a "-" sign. null, undefined and non-finite values
 * → "—".
 */
export function formatGp(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NO_VALUE;
  const sign = value < 0 ? '-' : '';
  let abs = Math.round(Math.abs(value));
  if (abs < 1000) return abs === 0 ? '0' : `${sign}${abs}`;

  let unit = 0;
  while (abs >= 1000 && unit < GP_UNITS.length - 1) {
    abs /= 1000;
    unit += 1;
  }
  // toPrecision rounds; 999.95K → "1.00e+3", which moves to the next unit.
  let digits = Number(abs.toPrecision(3));
  if (digits >= 1000 && unit < GP_UNITS.length - 1) {
    digits /= 1000;
    unit += 1;
  }
  return `${sign}${Number(digits.toPrecision(3))}${GP_UNITS[unit]}`;
}

/** 13034431 → "13,034,431" (rounded to an integer). null, undefined and non-finite values → "—". */
export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NO_VALUE;
  // Math.round first: Intl rounds half away from zero and would print "-0" for -0.4.
  const rounded = Math.round(value);
  return INTEGER_FORMAT.format(rounded === 0 ? 0 : rounded);
}

/**
 * Signed with thousands separators: "+12,345", "0". XP only goes up, so a minus sign is never
 * produced: a negative (or non-finite) value renders as "0".
 */
export function formatGain(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const rounded = Math.round(value);
  return rounded > 0 ? `+${formatNumber(rounded)}` : '0';
}

/** Account type labels by IRONMAN varbit value. */
export const ACCOUNT_TYPES: Readonly<Record<number, string>> = {
  0: 'Normal',
  1: 'Ironman',
  2: 'Ultimate Ironman',
  3: 'Hardcore Ironman',
  4: 'Group Ironman',
  5: 'Hardcore Group Ironman',
  6: 'Unranked Group Ironman',
};

/** Label for an account type, "Unknown" for null/unknown values. */
export function accountTypeLabel(type: number | null | undefined): string {
  if (type === null || type === undefined || !Object.hasOwn(ACCOUNT_TYPES, type)) return 'Unknown';
  return ACCOUNT_TYPES[type] ?? 'Unknown';
}

/**
 * "just now", "3 min ago", "2 h ago", "5 d ago" relative to `now` (floored: 59 s → "just now",
 * 119 min → "1 h ago"). Future dates → "just now", and so are invalid dates.
 */
export function relativeTime(date: Date, now: Date): string {
  const diff = now.getTime() - date.getTime();
  if (!Number.isFinite(diff) || diff < MINUTE_MS) return 'just now';
  if (diff < HOUR_MS) return `${Math.floor(diff / MINUTE_MS)} min ago`;
  if (diff < DAY_MS) return `${Math.floor(diff / HOUR_MS)} h ago`;
  return `${Math.floor(diff / DAY_MS)} d ago`;
}

/**
 * 5400 seconds → "1h 30m", 45 → "45s", 3600*30 → "30h 0m", 90 → "1m 30s": the two largest units,
 * hours never rolled into days. Fractions are floored; negative or non-finite values → "0s".
 */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0s';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
