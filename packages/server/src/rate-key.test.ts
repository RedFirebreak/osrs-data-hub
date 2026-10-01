import { describe, expect, it } from 'vitest';
import { pairRateKey } from './rate-key';

describe('pairRateKey', () => {
  it('keys IPv4 by the full address', () => {
    expect(pairRateKey('203.0.113.7')).toBe('203.0.113.7');
    expect(pairRateKey('203.0.113.8')).toBe('203.0.113.8');
  });

  it('keys IPv6 by its /64 prefix, whatever the spelling', () => {
    const key = '2001:db8:1:2::/64';
    expect(pairRateKey('2001:db8:1:2::1')).toBe(key);
    expect(pairRateKey('2001:db8:1:2:ffff:ffff:ffff:ffff')).toBe(key);
    expect(pairRateKey('2001:0DB8:0001:0002:0:0:0:9')).toBe(key);
    expect(pairRateKey('2001:db8:1:2::1%eth0')).toBe(key);
    expect(pairRateKey('2001:db8:1:3::1')).toBe('2001:db8:1:3::/64');
    expect(pairRateKey('::1')).toBe('0:0:0:0::/64');
    expect(pairRateKey('fe80::')).toBe('fe80:0:0:0::/64');
    expect(pairRateKey('2001:db8::')).toBe('2001:db8:0:0::/64');
  });

  it('keys an IPv4-mapped IPv6 address as the IPv4 address', () => {
    expect(pairRateKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(pairRateKey('::ffff:cb00:7107')).toBe('203.0.113.7');
    expect(pairRateKey('0:0:0:0:0:ffff:203.0.113.7')).toBe('203.0.113.7');
  });

  it('keys other embedded-IPv4 forms by their /64', () => {
    expect(pairRateKey('64:ff9b::203.0.113.7')).toBe('64:ff9b:0:0::/64');
    expect(pairRateKey('1:2:3:4:5:6:1.2.3.4')).toBe('1:2:3:4::/64');
  });

  it("uses 'unknown' without an address and the text itself for non-addresses", () => {
    expect(pairRateKey(null)).toBe('unknown');
    expect(pairRateKey(undefined)).toBe('unknown');
    expect(pairRateKey('  ')).toBe('unknown');
    expect(pairRateKey('1:2:3')).toBe('1:2:3');
    expect(pairRateKey('1::2::3')).toBe('1::2::3');
    expect(pairRateKey('::ffff:999.1.1.1')).toBe('::ffff:999.1.1.1');
    expect(pairRateKey('Not-An-IP')).toBe('not-an-ip');
  });
});
