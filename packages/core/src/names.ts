/**
 * Port of RuneLite `Text.toJagexName` (client 1.13.0, Text.java:160-163), verified identical on test
 * vectors: replace NBSP (U+00A0), '_' and '-' with a space, drop every non-ASCII char, then trim chars
 * <= U+0020 at both ends (Java String.trim semantics, NOT JS trim). Does not lowercase and does not
 * collapse inner spaces.
 */
export function toJagexName(name: string): string {
  // Without the u flag the class matches UTF-16 code units, so both halves of a surrogate pair go,
  // like Guava's CharMatcher.ascii() on Java chars.
  const ascii = name.replace(/[\u00A0_-]/g, ' ').replace(/[\u0080-\uFFFF]/g, '');
  let start = 0;
  let end = ascii.length;
  while (start < end && ascii.charCodeAt(start) <= 0x20) start++;
  while (end > start && ascii.charCodeAt(end - 1) <= 0x20) end--;
  return ascii.slice(start, end);
}

/** Key for name lookups: toJagexName(name).toLowerCase(). */
export function normalizeName(name: string): string {
  return toJagexName(name).toLowerCase();
}
