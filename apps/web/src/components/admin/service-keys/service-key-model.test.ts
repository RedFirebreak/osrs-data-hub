import { describe, expect, it } from 'vitest';
import { fieldErrorsFrom } from '@/lib/api-client';
import {
  EDIT_SERVICE_KEY_FIELDS,
  editServiceFormOf,
  editServiceKeyBody,
  SERVICE_KEY_FIELDS,
  emptyServiceKeyForm,
  parseRateLimit,
  serviceKeyBody,
  validateServiceKeyForm,
} from './service-key-model';

const LIMITS = { nameMax: 64, rateLimitMax: 6000 };

describe('validateServiceKeyForm', () => {
  it('needs a name and a category; the rate limit may be blank', () => {
    expect(validateServiceKeyForm(emptyServiceKeyForm(), LIMITS)).toEqual({
      name: expect.stringContaining('name') as string,
      categories: 'Choose at least one category.',
    });
    expect(
      validateServiceKeyForm(
        { ...emptyServiceKeyForm(), name: ' Map ', categories: ['activity'] },
        LIMITS,
      ),
    ).toEqual({});
  });

  it('checks the rate limit as a positive whole number within the maximum', () => {
    const form = { ...emptyServiceKeyForm(), name: 'Map', categories: ['activity' as const] };
    for (const bad of ['0', '-5', '1.5', 'abc', '10e3']) {
      expect(validateServiceKeyForm({ ...form, rateLimit: bad }, LIMITS)).toHaveProperty(
        'rateLimitPerMinute',
      );
    }
    expect(validateServiceKeyForm({ ...form, rateLimit: '6001' }, LIMITS).rateLimitPerMinute).toBe(
      'At most 6000 requests per minute.',
    );
    expect(validateServiceKeyForm({ ...form, rateLimit: ' 600 ' }, LIMITS)).toEqual({});
  });

  it('counts the name in characters after trimming', () => {
    const form = { ...emptyServiceKeyForm(), categories: ['stats' as const] };
    expect(validateServiceKeyForm({ ...form, name: 'x'.repeat(65) }, LIMITS).name).toBe(
      'At most 64 characters.',
    );
    expect(validateServiceKeyForm({ ...form, name: `${'é'.repeat(64)} ` }, LIMITS)).toEqual({});
  });
});

describe('parseRateLimit and serviceKeyBody', () => {
  it('reads the typed limit, blank as null and garbage as undefined', () => {
    expect(parseRateLimit('')).toBeNull();
    expect(parseRateLimit('  ')).toBeNull();
    expect(parseRateLimit('600')).toBe(600);
    expect(parseRateLimit('0')).toBeUndefined();
    expect(parseRateLimit('x')).toBeUndefined();
  });

  it('builds the request body in the schema’s shape, categories in canonical order', () => {
    expect(
      serviceKeyBody({
        name: ' Live map ',
        categories: ['location_live', 'activity'],
        rateLimit: '1200',
        expiry: '90',
      }),
    ).toEqual({
      name: 'Live map',
      categories: ['activity', 'location_live'],
      expiresInDays: 90,
      rateLimitPerMinute: 1200,
    });
    expect(serviceKeyBody({ ...emptyServiceKeyForm(), name: 'k', categories: ['stats'] })).toEqual({
      name: 'k',
      categories: ['stats'],
      expiresInDays: null,
      rateLimitPerMinute: null,
    });
  });
});

describe('SERVICE_KEY_FIELDS', () => {
  it('keeps the first message per known field and ignores the rest', () => {
    expect(
      fieldErrorsFrom(
        [
          { path: 'rateLimitPerMinute', message: 'too big' },
          { path: 'rateLimitPerMinute', message: 'second' },
          { path: 'categories.0', message: 'unknown' },
          { path: 'accountPublicIds', message: 'not a field of a service key' },
          { path: 'secret', message: 'nope' },
          'garbage',
        ],
        SERVICE_KEY_FIELDS,
      ),
    ).toEqual({ rateLimitPerMinute: 'too big', categories: 'unknown' });
    expect(fieldErrorsFrom(null, SERVICE_KEY_FIELDS)).toEqual({});
  });
});

describe('the edit form (D-111)', () => {
  const key = { name: 'Live map', categories: ['activity' as const], rateLimitPerMinute: 600 };

  it('shows a rate limit at the default as blank, and any other as typed', () => {
    expect(editServiceFormOf(key, 600)).toEqual({
      name: 'Live map',
      categories: ['activity'],
      rateLimit: '',
    });
    expect(editServiceFormOf({ ...key, rateLimitPerMinute: 900 }, 600).rateLimit).toBe('900');
  });

  it('sends null for a blank rate limit, so the key follows the default', () => {
    expect(
      editServiceKeyBody({
        name: ' Live map ',
        categories: ['hiscores', 'activity'],
        rateLimit: '',
      }),
    ).toEqual({ name: 'Live map', categories: ['activity', 'hiscores'], rateLimitPerMinute: null });
  });

  it('validates as the create form does', () => {
    expect(
      validateServiceKeyForm({ name: '', categories: [], rateLimit: 'x' }, LIMITS),
    ).toHaveProperty('rateLimitPerMinute');
    expect(EDIT_SERVICE_KEY_FIELDS).not.toContain('expiresInDays');
  });
});
