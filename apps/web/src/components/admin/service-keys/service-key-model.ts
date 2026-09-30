/**
 * Pure helpers for Admin → Integrations (service keys, D-87): the create form's state, validation
 * and request body, and the field errors of a failed create. No React, no browser APIs; unit-tested
 * in service-key-model.test.ts. The server's limits (name length, the highest rate limit) reach the
 * client as props from the page.
 */
import { CATEGORIES, type Category } from '@hub/core';
import { EXPIRY_OPTIONS } from '@/components/api-keys/api-key-model';

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

/** Client-side checks before sending (the server checks everything again). */
export function validateServiceKeyForm(
  form: ServiceKeyForm,
  limits: { nameMax: number; rateLimitMax: number },
): ServiceKeyErrors {
  const errors: ServiceKeyErrors = {};
  const name = form.name.replace(/\p{Cc}/gu, ' ').trim();
  if (name.length === 0) errors.name = 'Give the key a name, e.g. "Guild live map".';
  else if (Array.from(name).length > limits.nameMax) {
    errors.name = `At most ${limits.nameMax} characters.`;
  }
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
  const days = EXPIRY_OPTIONS.find((o) => o.value === form.expiry)?.days ?? null;
  return {
    name: form.name.trim(),
    categories: CATEGORIES.filter((c) => form.categories.includes(c)),
    expiresInDays: days,
    rateLimitPerMinute: parseRateLimit(form.rateLimit) ?? null,
  };
}

const FIELDS: ReadonlySet<string> = new Set<ServiceKeyField>([
  'name',
  'categories',
  'rateLimitPerMinute',
  'expiresInDays',
]);

/** The server's 400 `details` ([{ path, message }]) by form field (first message per field). */
export function serviceKeyFieldErrors(details: unknown): ServiceKeyErrors {
  const errors: ServiceKeyErrors = {};
  if (!Array.isArray(details)) return errors;
  for (const d of details) {
    if (typeof d !== 'object' || d === null) continue;
    const { path, message } = d as { path?: unknown; message?: unknown };
    if (typeof path !== 'string' || typeof message !== 'string') continue;
    const field = path.split('.')[0] ?? '';
    if (FIELDS.has(field) && errors[field as ServiceKeyField] === undefined) {
      errors[field as ServiceKeyField] = message;
    }
  }
  return errors;
}
