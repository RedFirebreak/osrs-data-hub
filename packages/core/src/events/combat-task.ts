/**
 * "(6 points)." / "(1 point)" at the end of the text, the period optional. It starts with a
 * literal "(" and has no open-ended prefix group, so a hostile taskName can't make it backtrack
 * quadratically.
 */
const POINTS_SUFFIX = /\(\s*(\d+)\s+points?\s*\)\s*\.?$/i;

/**
 * combatTask.taskName arrives untrimmed with a points suffix: " No Pressure (6 points)." →
 * { name: "No Pressure", points: 6 }. "(1 point)" is singular; the match is case-insensitive and
 * the trailing period is optional. Without a recognizable suffix the trimmed text is returned with
 * points null (a trailing "." is removed). A non-string gives { name: "", points: null }. A points
 * number too large to be exact (> 2^53 − 1) is still split off, with points null.
 */
export function parseCombatTaskName(taskName: unknown): { name: string; points: number | null } {
  if (typeof taskName !== 'string') return { name: '', points: null };
  const text = taskName.trim();
  const match = POINTS_SUFFIX.exec(text);
  if (match) {
    const points = Number(match[1]);
    return {
      name: text.slice(0, match.index).trimEnd(),
      points: Number.isSafeInteger(points) ? points : null,
    };
  }
  return { name: text.endsWith('.') ? text.slice(0, -1).trimEnd() : text, points: null };
}
