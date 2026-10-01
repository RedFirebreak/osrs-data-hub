import { AUDIT_ACTIONS } from '@hub/server';
import { describe, expect, it } from 'vitest';
import {
  adminFailureMessage,
  auditActionLabel,
  auditLogApiPath,
  auditMetaEntries,
  countsByLabel,
  decommissionConfirmMatches,
  describeIngestMeta,
  formatBytes,
  graceDaysLeft,
  httpStatusLabel,
  httpStatusTone,
  isAdminTabActive,
  offboardReasonLabel,
  parseDeviceFilter,
  parseRawPayloadQuery,
  prettyPayload,
  rawPayloadApiPath,
  rawPayloadsHref,
  shortId,
  sortStatusKeys,
  userActions,
  utcDateText,
} from './admin-model';

const UUID = '0192f3a4-1111-7abc-8def-0123456789ab';

describe('isAdminTabActive', () => {
  it('matches /admin exactly and other tabs by prefix', () => {
    expect(isAdminTabActive('/admin', '/admin')).toBe(true);
    expect(isAdminTabActive('/admin/devices', '/admin')).toBe(false);
    expect(isAdminTabActive('/admin/devices', '/admin/devices')).toBe(true);
    expect(isAdminTabActive('/admin/devices/x', '/admin/devices')).toBe(true);
    expect(isAdminTabActive('/admin/devicesx', '/admin/devices')).toBe(false);
    expect(isAdminTabActive(null, '/admin')).toBe(false);
  });
});

describe('users', () => {
  it('labels offboard reasons, unknown ones generically', () => {
    expect(offboardReasonLabel('left_guild')).toBe('Left the Discord server');
    expect(offboardReasonLabel('admin')).toBe('Offboarded by an admin');
    expect(offboardReasonLabel(null)).toBe('Unknown reason');
    expect(offboardReasonLabel('toString')).toBe('Unknown reason');
  });

  it('counts grace days left, rounded up and never negative', () => {
    const now = new Date('2026-09-29T12:00:00Z');
    expect(graceDaysLeft(new Date('2026-10-29T12:00:00Z'), now)).toBe(30);
    expect(graceDaysLeft('2026-09-29T15:00:00Z', now)).toBe(1);
    expect(graceDaysLeft(new Date('2026-09-28T12:00:00Z'), now)).toBe(0);
    expect(graceDaysLeft(null, now)).toBeNull();
    expect(graceDaysLeft('nope', now)).toBeNull();
  });

  it('offers offboard and restore by status, never offboarding yourself', () => {
    expect(userActions({ status: 'active', offboardReason: null, isSelf: false })).toEqual({
      offboard: true,
      restore: false,
    });
    expect(userActions({ status: 'active', offboardReason: null, isSelf: true })).toEqual({
      offboard: false,
      restore: false,
    });
    expect(userActions({ status: 'grace', offboardReason: 'left_guild', isSelf: false })).toEqual({
      offboard: true,
      restore: true,
    });
    expect(userActions({ status: 'grace', offboardReason: 'admin', isSelf: false })).toEqual({
      offboard: false,
      restore: true,
    });
  });
});

describe('devices', () => {
  it('parses ?show=, defaulting to all', () => {
    expect(parseDeviceFilter('outdated')).toBe('outdated');
    expect(parseDeviceFilter(['revoked', 'active'])).toBe('revoked');
    expect(parseDeviceFilter('bogus')).toBe('all');
    expect(parseDeviceFilter(undefined)).toBe('all');
  });
});

describe('ingest', () => {
  it('labels and colours HTTP statuses', () => {
    expect(httpStatusLabel('200')).toBe('Accepted');
    expect(httpStatusLabel('503')).toBe('Unavailable');
    expect(httpStatusLabel('pending')).toBe('No status yet');
    expect(httpStatusLabel('418')).toBe('Client error');
    expect(httpStatusTone('204')).toBe('ok');
    expect(httpStatusTone('400')).toBe('client');
    expect(httpStatusTone('500')).toBe('server');
    expect(httpStatusTone('pending')).toBe('pending');
  });

  it('sorts status keys numerically with pending last', () => {
    expect(sortStatusKeys(['pending', '503', '200', '400', '200'])).toEqual([
      '200',
      '400',
      '503',
      'pending',
    ]);
  });

  it('formats byte sizes', () => {
    expect(formatBytes(812)).toBe('812 B');
    expect(formatBytes(12_345)).toBe('12 KB');
    expect(formatBytes(2_048)).toBe('2.0 KB');
    expect(formatBytes(3_500_000)).toBe('3.3 MB');
    expect(formatBytes(Number.NaN)).toBe('—');
  });

  it('describes ingest meta and ignores malformed fields', () => {
    expect(
      describeIngestMeta({
        inserted: 3,
        duplicates: 1,
        skippedSections: ['player.inventory'],
        skippedEvents: 2,
        stale: true,
        error: 'plugin_outdated',
      }),
    ).toEqual([
      '3 events stored',
      '1 duplicate',
      '1 section skipped',
      '2 events skipped',
      'stale snapshot',
      'error: plugin_outdated',
    ]);
    expect(describeIngestMeta(null)).toEqual([]);
    expect(describeIngestMeta({ inserted: 0, skippedSections: 'x' } as never)).toEqual([]);
  });
});

describe('raw payload viewer', () => {
  it('parses filters and the cursor, ignoring malformed values', () => {
    expect(
      parseRawPayloadQuery({
        device: UUID.toUpperCase(),
        status: '503',
        before: '2026-09-29T10:00:00.123Z',
        beforeId: UUID,
      }),
    ).toEqual({
      deviceId: UUID,
      status: 503,
      before: { receivedAt: new Date('2026-09-29T10:00:00.123Z'), id: UUID },
    });
    expect(parseRawPayloadQuery({ status: 'pending' })).toEqual({ status: 'pending' });
    expect(
      parseRawPayloadQuery({ device: 'x', status: '99999', before: 'nope', beforeId: UUID }),
    ).toEqual({});
    expect(parseRawPayloadQuery({ before: '2026-09-29T10:00:00Z' })).toEqual({});
  });

  it('builds the URL for filters and the cursor, and parses it back', () => {
    expect(rawPayloadsHref({})).toBe('/admin/payloads');
    const query = {
      deviceId: UUID,
      status: 'pending' as const,
      before: { receivedAt: new Date('2026-09-29T10:00:00.123Z'), id: UUID },
    };
    const href = rawPayloadsHref(query);
    const params = Object.fromEntries(new URL(href, 'http://x').searchParams);
    expect(parseRawPayloadQuery(params)).toEqual(query);
  });

  it('pretty-prints JSON bodies, decoding Gson escapes, and keeps invalid ones as sent', () => {
    expect(prettyPayload('{"name":"Kree\\u0027arra"}')).toEqual({
      text: '{\n  "name": "Kree\'arra"\n}',
      json: true,
    });
    expect(prettyPayload('{"broken"')).toEqual({ text: '{"broken"', json: false });
  });

  it('builds the API path with an encoded receivedAt', () => {
    expect(rawPayloadApiPath(UUID, '2026-09-29T10:00:00.000Z')).toBe(
      `/api/app/admin/raw-payloads/${UUID}?receivedAt=2026-09-29T10%3A00%3A00.000Z`,
    );
  });
});

describe('audit log', () => {
  it('labels known actions and passes unknown ones through', () => {
    expect(auditActionLabel('device.revoked')).toBe('Device revoked');
    expect(auditActionLabel('something.new')).toBe('something.new');
    // Not a label of its own, so not an Object.prototype member either.
    expect(auditActionLabel('constructor')).toBe('constructor');
  });

  it('labels every action the hub writes, and retired ones old rows still hold', () => {
    for (const action of AUDIT_ACTIONS) {
      expect(auditActionLabel(action), action).toMatch(/^[A-Z][A-Za-z ]+$/);
    }
    expect(auditActionLabel('sharing.grant_added')).toBe('Sharing grant added');
    expect(auditActionLabel('sharing.grant_removed')).toBe('Sharing grant removed');
    expect(auditActionLabel('account.contributor_blocked')).toBe('Contributor blocked');
    expect(auditActionLabel('account.contributor_unblocked')).toBe('Contributor unblocked');
    expect(auditActionLabel('user.exported')).toBe('User data downloaded');
    expect(auditActionLabel('sharing.changed')).toBe('Sharing changed');
  });

  it('turns meta into key/value text, nested values as JSON, long ones cut', () => {
    expect(auditMetaEntries({ reason: 'admin', asAdmin: true, n: 3, nested: { a: [1] } })).toEqual([
      ['reason', 'admin'],
      ['asAdmin', 'true'],
      ['n', '3'],
      ['nested', '{"a":[1]}'],
    ]);
    const [[, long] = ['', '']] = auditMetaEntries({ x: 'y'.repeat(200) });
    expect(long).toHaveLength(80);
    expect(long.endsWith('…')).toBe(true);
    expect(auditMetaEntries(null)).toEqual([]);
    expect(auditMetaEntries([1, 2])).toEqual([['value', '[1,2]']]);
  });

  it('builds the load-more path', () => {
    expect(auditLogApiPath(123)).toBe('/api/app/admin/audit-log?before=123&limit=50');
  });
});

describe('utcDateText', () => {
  it('formats in UTC without Intl data, so server and browser agree', () => {
    const at = Date.parse('2026-09-29T08:05:00+02:00');
    expect(utcDateText(at, false)).toBe('29 Sep 2026');
    expect(utcDateText(at, true)).toBe('29 Sep 2026, 06:05 UTC');
    expect(utcDateText(Date.parse('2027-01-01T00:00:00Z'), true)).toBe('1 Jan 2027, 00:00 UTC');
    expect(utcDateText(Number.NaN, true)).toBeNull();
  });
});

describe('countsByLabel', () => {
  it('sums counter values per label value, leaving out empty and unlabelled series', () => {
    expect(
      countsByLabel(
        [
          { value: 812, labels: { status: '200' } },
          { value: 3, labels: { status: 401 } },
          { value: 2, labels: { status: '401' } },
          { value: 0, labels: { status: '503' } },
          { value: 5, labels: {} },
        ],
        'status',
      ),
    ).toEqual({ '200': 812, '401': 5 });
    expect(countsByLabel([], 'status')).toEqual({});
  });
});

describe('decommissionConfirmMatches', () => {
  it('needs the hub name exactly, ignoring surrounding spaces on both sides', () => {
    expect(decommissionConfirmMatches('Test Hub', 'Test Hub')).toBe(true);
    expect(decommissionConfirmMatches('  Test Hub ', 'Test Hub')).toBe(true);
    // HUB_NAME cut to 64 characters can end on a space.
    expect(decommissionConfirmMatches('A'.repeat(63), `${'A'.repeat(63)} `)).toBe(true);
    expect(decommissionConfirmMatches('test hub', 'Test Hub')).toBe(false);
    expect(decommissionConfirmMatches('Test  Hub', 'Test Hub')).toBe(false);
    expect(decommissionConfirmMatches(undefined, 'Test Hub')).toBe(false);
    expect(decommissionConfirmMatches('', ' ')).toBe(false);
  });
});

describe('adminFailureMessage', () => {
  const body = { error: { code: 'invalid', message: "you can't offboard yourself" } };

  it('uses the hub message for 400/403/503 and fixed texts otherwise', () => {
    expect(adminFailureMessage(400, body, 'fallback')).toBe("you can't offboard yourself");
    expect(adminFailureMessage(503, null, 'fallback')).toBe('fallback');
    expect(adminFailureMessage(403, null, 'fallback')).toBe('Only admins can do this.');
    expect(adminFailureMessage(401, body, 'fallback')).toBe(
      'Your session has ended. Sign in again.',
    );
    expect(adminFailureMessage(404, body, 'fallback')).toBe(
      'It no longer exists. Reload the page.',
    );
    expect(adminFailureMessage(500, body, 'fallback')).toBe('fallback');
  });
});

describe('shortId', () => {
  it('uses the random tail of a uuidv7, not its time prefix', () => {
    // Paired the same hour: same leading digits, different tails.
    expect(shortId('01a0ec80-db80-7215-b508-c0ffee000001')).toBe('ee000001');
    expect(shortId('01a0ec80-bd38-7446-9d47-900dface0002')).toBe('face0002');
    expect(shortId(UUID)).toBe('456789ab');
  });
});

describe('describeIngestMeta: ignored payloads', () => {
  it('says why in words, and keeps an unknown reason as sent', () => {
    expect(describeIngestMeta({ ignored: 'no_identity' })).toEqual([
      'ignored: no player in it (login screen, client start)',
    ]);
    expect(describeIngestMeta({ ignored: 'blocked' })).toEqual([
      'ignored: player blocked from this account',
    ]);
    expect(describeIngestMeta({ ignored: 'something_new' } as never)).toEqual([
      'ignored: something_new',
    ]);
  });
});
