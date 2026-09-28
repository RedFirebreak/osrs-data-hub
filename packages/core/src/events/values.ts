import { notImplemented } from '../todo';

/**
 * Σ gePrice × quantity computed with BigInt (gePrice is a Java long), returned as a number clamped
 * to [0, Number.MAX_SAFE_INTEGER]. Entries without finite numeric gePrice/quantity are ignored.
 * Returns null when `items` is not an array.
 */
export function itemsValue(items: unknown): number | null {
  return notImplemented('itemsValue');
}

/** Carried wealth: inventory + equipment value. */
export function carriedValue(inventory: unknown, equipment: unknown): number {
  return notImplemented('carriedValue');
}
