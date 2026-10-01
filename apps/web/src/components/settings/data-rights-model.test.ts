import { SELF_DELETE_CONFIRMATION } from '@hub/server';
import { describe, expect, it } from 'vitest';
import {
  confirmsDeletion,
  deleteErrorMessage,
  deletedLoginPath,
  graceUntilFrom,
} from './data-rights-model';

describe('confirmsDeletion', () => {
  it('takes "delete" in any case with surrounding space, as the server does', () => {
    for (const ok of ['delete', 'DELETE', '  Delete ']) {
      expect(confirmsDeletion(ok, SELF_DELETE_CONFIRMATION)).toBe(true);
    }
    for (const bad of ['', 'delet', 'deleted', 'delete!', 'de lete']) {
      expect(confirmsDeletion(bad, SELF_DELETE_CONFIRMATION)).toBe(false);
    }
  });
});

describe('deletedLoginPath', () => {
  it('sends the date to the login page, encoded', () => {
    expect(deletedLoginPath('2026-10-06T14:05:09.123Z')).toBe(
      '/login?deleted=2026-10-06T14%3A05%3A09.123Z',
    );
  });
});

describe('graceUntilFrom', () => {
  it('reads a valid ISO time only', () => {
    expect(graceUntilFrom({ graceUntil: '2026-10-06T14:05:09.123Z' })).toBe(
      '2026-10-06T14:05:09.123Z',
    );
    for (const bad of [null, {}, { graceUntil: 5 }, { graceUntil: 'soon' }, 'x']) {
      expect(graceUntilFrom(bad)).toBeNull();
    }
  });
});

describe('deleteErrorMessage', () => {
  it("shows the hub's reason for a refusal, and plain words otherwise", () => {
    const body = { error: { code: 'invalid', message: 'Type "delete" to confirm.' } };
    expect(deleteErrorMessage(400, body)).toBe('Type "delete" to confirm.');
    expect(deleteErrorMessage(401, null)).toMatch(/session has ended/);
    expect(deleteErrorMessage(503, null)).toMatch(/busy/);
    expect(
      deleteErrorMessage(500, { error: { message: 'Something went wrong on the hub.' } }),
    ).toBe("Couldn't delete your data. Try again in a moment.");
  });
});
