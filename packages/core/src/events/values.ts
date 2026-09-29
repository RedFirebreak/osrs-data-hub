const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Σ gePrice × quantity computed with BigInt (gePrice is a Java long), returned as a number clamped
 * to [0, Number.MAX_SAFE_INTEGER]. Entries that aren't objects, or whose gePrice/quantity aren't
 * finite integers (the Java long/int the plugin sends), are ignored.
 * Returns null when `items` is not an array.
 */
export function itemsValue(items: unknown): number | null {
  if (!Array.isArray(items)) return null;
  let total = 0n;
  for (const item of items) {
    if (typeof item !== 'object' || item === null) continue;
    const { gePrice, quantity } = item as { gePrice?: unknown; quantity?: unknown };
    // Number.isInteger rejects NaN, ±Infinity and fractions, so BigInt() below can't throw.
    if (!Number.isInteger(gePrice) || !Number.isInteger(quantity)) continue;
    total += BigInt(gePrice as number) * BigInt(quantity as number);
  }
  return clampToSafe(total);
}

/** Carried wealth: inventory + equipment value (each per itemsValue; a non-array counts as 0). */
export function carriedValue(inventory: unknown, equipment: unknown): number {
  const total = BigInt(itemsValue(inventory) ?? 0) + BigInt(itemsValue(equipment) ?? 0);
  return clampToSafe(total);
}

function clampToSafe(value: bigint): number {
  if (value <= 0n) return 0;
  return Number(value > MAX_SAFE ? MAX_SAFE : value);
}
