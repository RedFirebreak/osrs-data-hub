import { describe, expect, it } from 'vitest';
import { failureMessage, refreshesPage } from '@/lib/api-client';
import {
  UNNAMED_DEVICE,
  deviceApiPath,
  deviceFailure,
  deviceName,
  revokedByText,
} from './device-model';

describe('device-model', () => {
  it('names unlabelled devices', () => {
    expect(deviceName('Desktop PC')).toBe('Desktop PC');
    expect(deviceName(null)).toBe(UNNAMED_DEVICE);
    expect(deviceName('   ')).toBe(UNNAMED_DEVICE);
    expect(deviceName(undefined)).toBe(UNNAMED_DEVICE);
  });

  it('says who revoked a device', () => {
    expect(revokedByText('user')).toBe('Revoked by you');
    expect(revokedByText('admin')).toBe('Revoked by an admin');
    expect(revokedByText('offboarding')).toBe('Revoked when your access ended');
    expect(revokedByText(null)).toBe('Revoked');
  });

  it('builds the API path with the id encoded', () => {
    expect(deviceApiPath('0192-ab')).toBe('/api/app/devices/0192-ab');
    expect(deviceApiPath('a/b')).toBe('/api/app/devices/a%2Fb');
  });

  it('explains failed requests', () => {
    expect(failureMessage(401, null, deviceFailure('rename'))).toMatch(/session has ended/);
    expect(failureMessage(404, null, deviceFailure('revoke'))).toMatch(/no longer exists/);
    const invalid = { error: { code: 'invalid_request', message: 'The request is invalid.' } };
    expect(failureMessage(400, invalid, deviceFailure('rename'))).toBe('The request is invalid.');
    expect(failureMessage(503, {}, deviceFailure('revoke'))).toMatch(/Couldn't revoke/);
    expect(failureMessage(500, invalid, deviceFailure('rename'))).toMatch(/Couldn't rename/);
  });

  it('refreshes the page when the device to revoke is already gone, or the session is', () => {
    expect(refreshesPage(404, deviceFailure('revoke'))).toBe(true);
    expect(refreshesPage(401, deviceFailure('revoke'))).toBe(true);
    expect(refreshesPage(401, deviceFailure('rename'))).toBe(true);
    expect(refreshesPage(404, deviceFailure('rename'))).toBe(false);
    expect(refreshesPage(503, deviceFailure('revoke'))).toBe(false);
  });
});
