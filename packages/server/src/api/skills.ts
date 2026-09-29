/** Skill names in API parameters: matched case-insensitively against the `skills` table. */
import { skills as skillsTable, type DbOrTx } from '@hub/db';
import { ApiError } from './errors';

/** Longest skill name accepted in a parameter. */
const MAX_SKILL_NAME = 64;

/**
 * The stored spelling of each requested skill name ("attack" → "Attack", "overall" → "Overall"), in
 * request order without duplicates. A name the hub has never seen is ApiError 'invalid' naming it:
 * a typo should say so rather than chart nothing. The names are matched in memory (the table holds a
 * few dozen rows), so no parameter text reaches a query.
 */
export async function canonicalSkills(db: DbOrTx, names: readonly string[]): Promise<string[]> {
  const rows = await db.select({ name: skillsTable.name }).from(skillsTable);
  const byKey = new Map(rows.map((r) => [r.name.toLowerCase(), r.name]));
  const out: string[] = [];
  for (const name of names) {
    const canonical =
      name.length <= MAX_SKILL_NAME ? byKey.get(name.trim().toLowerCase()) : undefined;
    if (canonical === undefined)
      throw new ApiError('invalid', `unknown skill: ${name.slice(0, MAX_SKILL_NAME)}`);
    if (!out.includes(canonical)) out.push(canonical);
  }
  return out;
}
