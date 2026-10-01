/**
 * The Settings form's model, kept free of React so it is unit-tested: form state from saved settings,
 * the PATCH body for what changed (only changed fields are sent, D-10 strict schema on the server),
 * the fields the route's 400 `details` can name, and the time-zone picker's groups.
 */
import type { UserSettings, UserSettingsPatchInput } from '@hub/server';

export type SettingsField =
  'toastsEnabled' | 'toastTypes' | 'toastMinLootValue' | 'toastOwnAccountsOnly' | 'timezone';

export type FieldErrors = Partial<Record<SettingsField, string>>;

/** The form's fields the route's 400 `details` can name (fieldErrorsFrom, lib/api-client.ts). */
export const SETTINGS_FIELDS: readonly SettingsField[] = [
  'toastsEnabled',
  'toastTypes',
  'toastMinLootValue',
  'toastOwnAccountsOnly',
  'timezone',
];

export interface SettingsFormState {
  toastsEnabled: boolean;
  /** "Every event type" (toastTypes null). */
  allTypes: boolean;
  /** The chosen types when !allTypes. */
  types: string[];
  /** The minimum loot value as typed. */
  minLootValue: string;
  ownAccountsOnly: boolean;
  timezone: string;
}

/** The form's state for saved settings. With "every type", all boxes start ticked. */
export function formStateFrom(
  settings: UserSettings,
  eventTypes: readonly string[],
): SettingsFormState {
  return {
    toastsEnabled: settings.toast.enabled,
    allTypes: settings.toast.types === null,
    types: settings.toast.types === null ? [...eventTypes] : [...settings.toast.types],
    minLootValue: String(settings.toast.minLootValue),
    ownAccountsOnly: settings.toast.ownAccountsOnly,
    timezone: settings.timezone,
  };
}

const GP_SUFFIX: Readonly<Record<string, number>> = {
  '': 1,
  k: 1_000,
  m: 1_000_000,
  b: 1_000_000_000,
};

/**
 * A whole number of gp from 0 to `max`, else null. '' counts as 0; spaces and underscores are
 * ignored ("1 000"), commas only as thousands separators of a plain number ("1,000,000"), and the
 * in-game shorthand works ("100k", "1.5m", "2b"). Any other comma is refused rather than dropped:
 * "1,5m" is a decimal comma (1.5M), and reading it as 15M would silently set ten times the value.
 */
export function parseMinLootValue(raw: string, max: number): number | null {
  let text = raw.trim().toLowerCase().replace(/[\s_]/g, '');
  if (text.includes(',')) {
    if (!/^\d{1,3}(?:,\d{3})+$/.test(text)) return null;
    text = text.replace(/,/g, '');
  }
  if (text === '') return 0;
  const match = /^(\d{1,12})(?:\.(\d{1,3}))?([kmb]?)$/.exec(text);
  if (!match) return null;
  const [, whole = '', fraction, suffix = ''] = match;
  if (fraction !== undefined && suffix === '') return null; // gp are whole numbers
  const n = Math.round(Number(`${whole}.${fraction ?? '0'}`) * (GP_SUFFIX[suffix] ?? 1));
  return Number.isSafeInteger(n) && n <= max ? n : null;
}

function sameTypes(a: readonly string[] | null, b: readonly string[] | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((t) => set.has(t));
}

/** The types to store: null for every type, else the chosen ones in the canonical order. */
export function chosenTypes(
  state: SettingsFormState,
  eventTypes: readonly string[],
): string[] | null {
  if (state.allTypes) return null;
  const chosen = new Set(state.types);
  return eventTypes.filter((t) => chosen.has(t));
}

/**
 * The PATCH body for what differs from `saved`, and client-side field errors (the server validates
 * again). An empty patch means nothing to save.
 */
export function buildPatch(
  state: SettingsFormState,
  saved: UserSettings,
  eventTypes: readonly string[],
  maxMinLootValue: number,
): { patch: UserSettingsPatchInput; errors: FieldErrors } {
  const patch: UserSettingsPatchInput = {};
  const errors: FieldErrors = {};
  if (state.toastsEnabled !== saved.toast.enabled) patch.toastsEnabled = state.toastsEnabled;
  const types = chosenTypes(state, eventTypes);
  if (!sameTypes(types, saved.toast.types)) {
    patch.toastTypes = types as UserSettingsPatchInput['toastTypes'];
  }
  const min = parseMinLootValue(state.minLootValue, maxMinLootValue);
  if (min === null) {
    errors.toastMinLootValue = `Enter a whole number of gp from 0 to ${maxMinLootValue.toLocaleString('en-US')}.`;
  } else if (min !== saved.toast.minLootValue) {
    patch.toastMinLootValue = min;
  }
  if (state.ownAccountsOnly !== saved.toast.ownAccountsOnly) {
    patch.toastOwnAccountsOnly = state.ownAccountsOnly;
  }
  if (state.timezone !== saved.timezone) patch.timezone = state.timezone;
  return { patch, errors };
}

/** Whether the patch changes the toast filter (the live stream must be reopened to apply it). */
export function changesToastFilter(patch: UserSettingsPatchInput): boolean {
  return (
    patch.toastsEnabled !== undefined ||
    patch.toastTypes !== undefined ||
    patch.toastMinLootValue !== undefined ||
    patch.toastOwnAccountsOnly !== undefined
  );
}

export interface TimeZoneGroup {
  label: string;
  zones: { value: string; label: string }[];
}

/**
 * The picker's option groups: "UTC" first, then one group per region ("Europe", "America"…), with
 * readable labels ("America/Argentina/Buenos_Aires" → "Argentina / Buenos Aires" under "America").
 */
export function groupTimeZones(zones: readonly string[]): TimeZoneGroup[] {
  const groups = new Map<string, TimeZoneGroup>();
  for (const zone of zones) {
    const slash = zone.indexOf('/');
    const region = slash === -1 ? 'Other' : zone.slice(0, slash);
    const rest = slash === -1 ? zone : zone.slice(slash + 1);
    const label = zone === 'UTC' ? 'UTC' : region;
    let group = groups.get(label);
    if (!group) {
      group = { label, zones: [] };
      groups.set(label, group);
    }
    group.zones.push({ value: zone, label: rest.replace(/_/g, ' ').replace(/\//g, ' / ') });
  }
  const list = [...groups.values()];
  const utc = list.filter((g) => g.label === 'UTC');
  const others = list
    .filter((g) => g.label !== 'UTC')
    .sort((a, b) =>
      a.label === 'Other' ? 1 : b.label === 'Other' ? -1 : a.label.localeCompare(b.label),
    );
  return [...utc, ...others];
}
