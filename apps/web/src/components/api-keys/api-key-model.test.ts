import { DAY_MS } from '@hub/core';
import {
  API_KEY_MAX_EXPIRY_DAYS,
  API_KEY_NAME_MAX,
  CreateApiKeySchema,
  UpdateApiKeySchema,
  type ApiKeyInfo,
} from '@hub/server';
import { describe, expect, it } from 'vitest';
import { failureMessage, fieldErrorsFrom, refreshesPage } from '@/lib/api-client';
import {
  DELETE_KEY_FAILURE,
  EDIT_KEY_FAILURE,
  editFormOf,
  editKeyBody,
  EXPIRY_OPTIONS,
  apiKeyPath,
  CREATE_KEY_FAILURE,
  CREATE_KEY_FIELDS,
  createKeyBody,
  createdKeyFrom,
  emptyCreateForm,
  expiryText,
  maskedKey,
  REVOKE_KEY_FAILURE,
  scopeText,
  validateCreateForm,
  type CreateKeyForm,
} from './api-key-model';

const NOW = '2026-09-29T12:00:00.000Z';
const at = (ms: number) => new Date(Date.parse(NOW) + ms).toISOString();

describe('display texts', () => {
  it('masks the key to its prefix', () => {
    expect(maskedKey('AbCdE12345')).toBe('ohub_AbCdE12345_…');
  });

  it('describes the scope', () => {
    const base: Pick<ApiKeyInfo, 'accountScope' | 'accounts'> = {
      accountScope: 'all_visible',
      accounts: null,
    };
    expect(scopeText(base)).toBe('Every account you can see, now and later');
    const one = [{ publicId: 'a', name: 'A', visible: true }];
    expect(scopeText({ accountScope: 'list', accounts: one })).toBe('1 account');
    expect(scopeText({ accountScope: 'list', accounts: [...one, ...one] })).toBe('2 accounts');
    expect(scopeText({ accountScope: 'list', accounts: [] })).toMatch(/no longer exist/);
  });

  it('says when a key expires', () => {
    expect(expiryText(null, NOW)).toBe('Never');
    expect(expiryText(at(30 * DAY_MS), NOW)).toBe('in 30 days');
    expect(expiryText(at(30 * DAY_MS - 5_000), NOW)).toBe('in 30 days');
    expect(expiryText(at(DAY_MS + 1000), NOW)).toBe('in 1 day');
    expect(expiryText(at(5 * 60 * 60 * 1000), NOW)).toBe('in 5 h');
    expect(expiryText(at(10 * 60 * 1000), NOW)).toBe('within the hour');
    expect(expiryText(at(-2 * DAY_MS), NOW)).toBe('Expired 2 d ago');
  });

  it('builds the key path', () => {
    expect(apiKeyPath('a/b')).toBe('/api/app/api-keys/a%2Fb');
  });
});

describe('the create form', () => {
  const filled: CreateKeyForm = {
    name: ' Home Assistant ',
    categories: ['activity', 'stats'],
    scope: 'all_visible',
    accountPublicIds: [],
    expiry: 'never',
  };

  it('starts empty: no category preselected', () => {
    expect(emptyCreateForm()).toEqual({
      name: '',
      categories: [],
      scope: 'all_visible',
      accountPublicIds: [],
      expiry: 'never',
    });
  });

  it('validates like the server', () => {
    expect(validateCreateForm(filled, API_KEY_NAME_MAX)).toEqual({});
    expect(validateCreateForm(emptyCreateForm(), API_KEY_NAME_MAX)).toEqual({
      name: expect.any(String) as string,
      categories: expect.any(String) as string,
    });
    expect(
      validateCreateForm({ ...filled, name: 'x'.repeat(API_KEY_NAME_MAX + 1) }, API_KEY_NAME_MAX),
    ).toHaveProperty('name');
    // Code points, not UTF-16 units: 64 emoji fit.
    expect(
      validateCreateForm({ ...filled, name: '🐉'.repeat(API_KEY_NAME_MAX) }, API_KEY_NAME_MAX),
    ).toEqual({});
    expect(validateCreateForm({ ...filled, scope: 'list' }, API_KEY_NAME_MAX)).toHaveProperty(
      'accountPublicIds',
    );
  });

  it('builds a body the server accepts', () => {
    const body = createKeyBody({ ...filled, expiry: '90' });
    expect(body).toEqual({
      name: 'Home Assistant',
      categories: ['stats', 'activity'],
      accountScope: 'all_visible',
      expiresInDays: 90,
    });
    expect(CreateApiKeySchema.safeParse(body).success).toBe(true);
    const listBody = createKeyBody({ ...filled, scope: 'list', accountPublicIds: ['abc123'] });
    expect(listBody).toMatchObject({ accountScope: 'list', accountPublicIds: ['abc123'] });
    expect(CreateApiKeySchema.safeParse(listBody).success).toBe(true);
    expect(createKeyBody(filled).expiresInDays).toBeNull();
  });

  it('offers only expiries the server allows', () => {
    for (const option of EXPIRY_OPTIONS) {
      if (option.days !== null) expect(option.days).toBeLessThanOrEqual(API_KEY_MAX_EXPIRY_DAYS);
    }
  });

  it('maps the server’s field errors to the form', () => {
    expect(
      fieldErrorsFrom(
        [
          { path: 'name', message: 'too long' },
          { path: 'name', message: 'second' },
          { path: 'accountPublicIds.0', message: 'not an account id' },
          { path: 'rateLimitPerMinute', message: 'not a field of a user key' },
          { path: '', message: 'unknown key' },
          'junk',
        ],
        CREATE_KEY_FIELDS,
      ),
    ).toEqual({ name: 'too long', accountPublicIds: 'not an account id' });
    expect(fieldErrorsFrom(undefined, CREATE_KEY_FIELDS)).toEqual({});
  });
});

describe('responses', () => {
  it('reads the key from a 201 body', () => {
    expect(createdKeyFrom({ key: 'ohub_x_y', info: {} })).toBe('ohub_x_y');
    expect(createdKeyFrom({ key: 42 })).toBeNull();
    expect(createdKeyFrom(null)).toBeNull();
  });

  it('explains failures', () => {
    const body = { error: { code: 'limit', message: 'you already have 10 active API keys' } };
    expect(failureMessage(409, body, CREATE_KEY_FAILURE)).toBe(
      'you already have 10 active API keys',
    );
    expect(failureMessage(409, null, CREATE_KEY_FAILURE)).toMatch(/most active keys allowed/);
    expect(failureMessage(401, null, CREATE_KEY_FAILURE)).toMatch(/session/);
    expect(failureMessage(500, body, CREATE_KEY_FAILURE)).toMatch(/Couldn't create/);
    expect(failureMessage(404, null, REVOKE_KEY_FAILURE)).toMatch(/no longer exists/);
    expect(failureMessage(500, null, REVOKE_KEY_FAILURE)).toMatch(/Couldn't revoke/);
    expect(failureMessage(400, body, REVOKE_KEY_FAILURE)).toMatch(/Couldn't revoke/);
  });

  it('refreshes the page when the key to revoke is already gone', () => {
    expect(refreshesPage(404, REVOKE_KEY_FAILURE)).toBe(true);
    expect(refreshesPage(404, CREATE_KEY_FAILURE)).toBe(false);
  });
});

describe('the edit form (D-111)', () => {
  const listed = {
    name: 'Map',
    categories: ['stats', 'hiscores'] as ApiKeyInfo['categories'],
    accountScope: 'list' as const,
    accounts: [
      { publicId: 'accVisible', name: 'Zezima', visible: true },
      { publicId: 'accHidden', name: null, visible: false },
    ],
  };

  it('starts from the key as it is, without the accounts the user no longer sees', () => {
    expect(editFormOf(listed)).toEqual({
      name: 'Map',
      categories: ['stats', 'hiscores'],
      scope: 'list',
      accountPublicIds: ['accVisible'],
      hiddenAccounts: 1,
    });
    expect(editFormOf({ ...listed, accountScope: 'all_visible', accounts: null })).toMatchObject({
      scope: 'all_visible',
      accountPublicIds: [],
      hiddenAccounts: 0,
    });
  });

  it('sends a body the server accepts, the account list only with a list scope', () => {
    const { hiddenAccounts: _, ...form } = editFormOf(listed);
    const body = editKeyBody({ ...form, name: '  Map  ' });
    expect(body).toEqual({
      name: 'Map',
      categories: ['stats', 'hiscores'],
      accountScope: 'list',
      accountPublicIds: ['accVisible'],
    });
    expect(UpdateApiKeySchema.safeParse(body).success).toBe(true);
    const all = editKeyBody({ ...form, scope: 'all_visible' });
    expect(all).not.toHaveProperty('accountPublicIds');
    expect(UpdateApiKeySchema.safeParse(all).success).toBe(true);
  });

  it('tells a 409 with the hub’s message and refreshes on a 404', () => {
    const body = {
      error: {
        code: 'conflict',
        message: 'This key is revoked. Only an active key can be changed.',
      },
    };
    expect(failureMessage(409, body, EDIT_KEY_FAILURE)).toBe(body.error.message);
    expect(failureMessage(409, null, DELETE_KEY_FAILURE)).toBe(
      'Revoke the key before deleting it.',
    );
    expect(refreshesPage(404, EDIT_KEY_FAILURE)).toBe(true);
    expect(refreshesPage(404, DELETE_KEY_FAILURE)).toBe(true);
  });
});
