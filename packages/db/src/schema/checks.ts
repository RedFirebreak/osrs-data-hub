import { sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

/**
 * `column IN ('a', 'b')`, the body of an enum-like CHECK constraint. drizzle's `{ enum }` on a text
 * column is TypeScript-only; a `check()` built from the same array makes the database enforce it and
 * makes `drizzle-kit generate` emit a migration when the array changes. The values are inlined with
 * `sql.raw`: drizzle-kit writes a CHECK's SQL text into the migration, where a bound parameter would
 * come out as `$1`. They are constants from code, never input.
 */
export function isOneOf(column: AnyPgColumn, values: readonly string[]): SQL {
  const list = values.map((v) => `'${v.replaceAll("'", "''")}'`).join(', ');
  return sql`${column} IN (${sql.raw(list)})`;
}

/** As `isOneOf`, for a nullable column. */
export function isNullOrOneOf(column: AnyPgColumn, values: readonly string[]): SQL {
  return sql`${column} IS NULL OR ${isOneOf(column, values)}`;
}
