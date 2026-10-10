/**
 * Pure helpers for Admin → Integrations (service keys, D-88, D-111): the create and edit forms' state,
 * validation and request bodies, and the fields a failed create or edit can name. No React, no browser APIs; unit-tested
 * in service-key-model.test.ts. The server's limits (name length, the highest rate limit) reach the
 * client as props from the page. The name and expiry rules are the user keys' (api-key-model.ts).
 */
import { CATEGORIES, type Category } from '@hub/core';
import { expiryDays, keyNameError } from '@/components/api-keys/api-key-model';

export interface ServiceKeyForm {
  name: string;
  categories: Category[];
  /** Requests per minute as typed; '' = the default. */
  rateLimit: string;
  /** An EXPIRY_OPTIONS value. */
  expiry: string;
}

/** The empty form: nothing preselected, the admin chooses the categories (as for user keys, D-76). */
export function emptyServiceKeyForm(): ServiceKeyForm {
  return { name: '', categories: [], rateLimit: '', expiry: 'never' };
}

export type ServiceKeyField = 'name' | 'categories' | 'rateLimitPerMinute' | 'expiresInDays';
export type ServiceKeyErrors = Partial<Record<ServiceKeyField, string>>;

/** Client-side checks before sending (the server checks everything again); also the edit form's. */
export function validateServiceKeyForm(
  form: Omit<ServiceKeyForm, 'expiry'>,
  limits: { nameMax: number; rateLimitMax: number },
): ServiceKeyErrors {
  const errors: ServiceKeyErrors = {};
  const name = keyNameError(form.name, limits.nameMax, 'Guild live map');
  if (name) errors.name = name;
  if (form.categories.length === 0) errors.categories = 'Choose at least one category.';
  const rate = parseRateLimit(form.rateLimit);
  if (rate === undefined) {
    errors.rateLimitPerMinute = `A whole number from 1 to ${limits.rateLimitMax}.`;
  } else if (rate !== null && rate > limits.rateLimitMax) {
    errors.rateLimitPerMinute = `At most ${limits.rateLimitMax} requests per minute.`;
  }
  return errors;
}

/** The typed rate limit: null when blank (the default), undefined when not a positive whole number. */
export function parseRateLimit(value: string): number | null | undefined {
  const text = value.trim();
  if (text === '') return null;
  if (!/^\d{1,9}$/.test(text)) return undefined;
  const n = Number(text);
  return n >= 1 ? n : undefined;
}

/** The POST /api/app/admin/service-keys body for a valid form (CreateServiceKeySchema's input). */
export function serviceKeyBody(form: ServiceKeyForm): Record<string, unknown> {
  return {
    name: form.name.trim(),
    categories: CATEGORIES.filter((c) => form.categories.includes(c)),
    expiresInDays: expiryDays(form.expiry),
    rateLimitPerMinute: parseRateLimit(form.rateLimit) ?? null,
  };
}

/** The form's fields the server's 400 `details` can name (fieldErrorsFrom, lib/api-client.ts). */
export const SERVICE_KEY_FIELDS: readonly ServiceKeyField[] = [
  'name',
  'categories',
  'rateLimitPerMinute',
  'expiresInDays',
];

/** The edit form (D-111): name, categories and rate limit; the expiry stays as it was created. */
export type EditServiceKeyForm = Omit<ServiceKeyForm, 'expiry'>;

/** The edit form of a service key as it is now; a rate limit at the default shows as blank. */
export function editServiceFormOf(
  info: { name: string; categories: readonly Category[]; rateLimitPerMinute: number },
  rateLimitDefault: number,
): EditServiceKeyForm {
  return {
    name: info.name,
    categories: [...info.categories],
    rateLimit: info.rateLimitPerMinute === rateLimitDefault ? '' : String(info.rateLimitPerMinute),
  };
}

/** The PATCH /api/app/admin/service-keys/[id] body for a valid form (UpdateServiceKeySchema's input). */
export function editServiceKeyBody(form: EditServiceKeyForm): Record<string, unknown> {
  return {
    name: form.name.trim(),
    categories: CATEGORIES.filter((c) => form.categories.includes(c)),
    rateLimitPerMinute: parseRateLimit(form.rateLimit) ?? null,
  };
}

export type EditServiceKeyField = Exclude<ServiceKeyField, 'expiresInDays'>;

/** The edit form's fields the server's 400 `details` can name. */
export const EDIT_SERVICE_KEY_FIELDS: readonly EditServiceKeyField[] = [
  'name',
  'categories',
  'rateLimitPerMinute',
];
