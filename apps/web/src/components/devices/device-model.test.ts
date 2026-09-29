import { describe, expect, it } from 'vitest';
import {
  UNNAMED_DEVICE,
  deviceApiPath,
  deviceFailureMessage,
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
    expect(deviceFailureMessage(401, null, 'rename')).toMatch(/session has ended/);
    expect(deviceFailureMessage(404, null, 'revoke')).toMatch(/no longer exists/);
    const invalid = { error: { code: 'invalid_request', message: 'The request is invalid.' } };
    expect(deviceFailureMessage(400, invalid, 'rename')).toBe('The request is invalid.');
    expect(deviceFailureMessage(503, {}, 'revoke')).toMatch(/Couldn't revoke/);
    expect(deviceFailureMessage(500, invalid, 'rename')).toMatch(/Couldn't rename/);
  });
});
