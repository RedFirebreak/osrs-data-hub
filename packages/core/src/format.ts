import { notImplemented } from './todo';

/** 38_200_000 → "38.2M", 1_500 → "1.5K", 999 → "999", 2_147_000_000 → "2.15B" (3 significant digits max). */
export function formatGp(value: number | null | undefined): string {
  return notImplemented('formatGp');
}

/** 13034431 → "13,034,431". */
export function formatNumber(value: number | null | undefined): string {
  return notImplemented('formatNumber');
}

/** Signed with thousands separators: "+12,345", "0", "−" is never produced for XP gains. */
export function formatGain(value: number): string {
  return notImplemented('formatGain');
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
  return notImplemented('accountTypeLabel');
}

/** "just now", "3 min ago", "2 h ago", "5 d ago" relative to `now`. Future dates → "just now". */
export function relativeTime(date: Date, now: Date): string {
  return notImplemented('relativeTime');
}

/** 5400 seconds → "1h 30m", 45 → "45s", 3600*30 → "30h 0m". */
export function formatDuration(seconds: number): string {
  return notImplemented('formatDuration');
}
