/**
 * Per-user preferences (handoff §8 `user_settings`, §11 toast filter, §12 Settings). A missing row
 * means the defaults: every toast the viewer may see (DEFAULT_TOAST_FILTER) and UTC.
 */
import { DEFAULT_TOAST_FILTER, KNOWN_EVENT_TYPES, type ToastFilter } from '@hub/core';
import { userSettings, type Db, type DbOrTx } from '@hub/db';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';

export interface UserSettings {
  toast: ToastFilter;
  /** IANA time zone name, used to show times and to cut "today" for the viewer. */
  timezone: string;
}

export const DEFAULT_TIMEZONE = 'UTC';

/** Highest accepted minimum loot value for toasts (2^31, above the max cash stack). */
export const MAX_TOAST_MIN_LOOT_VALUE = 2 ** 31;

// Letters, digits and _+- in slash-separated parts. Keeps out the UTC offsets V8 also accepts as a
// timeZone ("+01:00", "-01"): Postgres reads POSIX offsets with the opposite sign.
const IANA_NAME = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;

/**
 * The canonical spelling of an IANA time zone name ("europe/amsterdam" → "Europe/Amsterdam",
 * "Etc/UTC" → "UTC"), or null when it isn't one this runtime knows. Checked with Intl.DateTimeFormat
 * rather than Intl.supportedValuesOf, whose list lacks "UTC" and alias names.
 */
export function canonicalTimeZone(name: string): string | null {
  if (!IANA_NAME.test(name)) return null;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: name }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/** Time zone names for the settings picker: UTC first, then the runtime's canonical IANA names. */
export function supportedTimeZones(): string[] {
  return [DEFAULT_TIMEZONE, ...Intl.supportedValuesOf('timeZone').filter((z) => z !== 'UTC')];
}

const TimeZoneSchema = z
  .string()
  .max(64)
  .transform((name, ctx) => {
    const canonical = canonicalTimeZone(name);
    if (canonical === null) {
      ctx.addIssue({
        code: 'custom',
        message: 'must be an IANA time zone name such as Europe/Amsterdam',
      });
      return z.NEVER;
    }
    return canonical;
  });

/**
 * A settings change from the Settings page (PATCH): every field optional, unknown keys rejected
 * (D-10: strict for our own API). `toastTypes` is a list of stored event types (duplicates dropped),
 * or null for "every type"; an empty list allows none. `timezone` is stored in its canonical spelling.
 */
export const UserSettingsPatchSchema = z.strictObject({
  toastsEnabled: z.boolean().optional(),
  toastTypes: z
    .array(z.enum(KNOWN_EVENT_TYPES))
    .max(64)
    .transform((types) => [...new Set(types)])
    .nullable()
    .optional(),
  toastMinLootValue: z.number().int().min(0).max(MAX_TOAST_MIN_LOOT_VALUE).optional(),
  toastOwnAccountsOnly: z.boolean().optional(),
  timezone: TimeZoneSchema.optional(),
});

export type UserSettingsPatch = z.output<typeof UserSettingsPatchSchema>;
/** The request body shape the Settings page sends. */
export type UserSettingsPatchInput = z.input<typeof UserSettingsPatchSchema>;

type UserSettingsRow = typeof userSettings.$inferSelect;

function fromRow(row: UserSettingsRow | undefined): UserSettings {
  if (!row) return { toast: { ...DEFAULT_TOAST_FILTER }, timezone: DEFAULT_TIMEZONE };
  return {
    toast: {
      enabled: row.toastsEnabled,
      types: row.toastTypes,
      minLootValue: row.toastMinLootValue,
      ownAccountsOnly: row.toastOwnAccountsOnly,
    },
    timezone: row.timezone,
  };
}

/** The user's settings; the defaults when they never saved any (or the user doesn't exist). */
export async function getUserSettings(db: DbOrTx, userId: string): Promise<UserSettings> {
  const [row] = await db.select().from(userSettings).where(eq(userSettings.userId, userId));
  return fromRow(row);
}

/**
 * Validates `patch` with UserSettingsPatchSchema (throws its ZodError, which the route turns into a
 * 400 with field errors) and applies it: only the fields present change, a first save starts from
 * the defaults. Returns the settings as stored.
 */
export async function updateUserSettings(
  db: Db,
  userId: string,
  patch: unknown,
): Promise<UserSettings> {
  const changes = UserSettingsPatchSchema.parse(patch);
  const set = Object.fromEntries(
    Object.entries(changes).filter(([, value]) => value !== undefined),
  ) as Partial<UserSettingsPatch>;
  const [row] = await db
    .insert(userSettings)
    .values({ userId, ...set })
    .onConflictDoUpdate({ target: userSettings.userId, set: { ...set, updatedAt: sql`now()` } })
    .returning();
  return fromRow(row);
}
