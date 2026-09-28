import { describe, expect, it } from 'vitest';
import { clientIpFromHeaders } from './http';

const xff = (...values: string[]) => {
  const h = new Headers();
  for (const v of values) h.append('X-Forwarded-For', v);
  return h;
};

describe('clientIpFromHeaders', () => {
  it('takes the entry trustHops positions from the right', () => {
    const h = xff('203.0.113.9, 10.0.0.2, 10.0.0.1');
    expect(clientIpFromHeaders(h, 1)).toBe('10.0.0.1');
    expect(clientIpFromHeaders(h, 2)).toBe('10.0.0.2');
    expect(clientIpFromHeaders(h, 3)).toBe('203.0.113.9');
  });

  it('takes the leftmost entry when there are fewer entries than hops', () => {
    expect(clientIpFromHeaders(xff('203.0.113.9, 10.0.0.1'), 5)).toBe('203.0.113.9');
    expect(clientIpFromHeaders(xff('203.0.113.9'), 2)).toBe('203.0.113.9');
  });

  it('ignores what the client prepended beyond the trusted hops', () => {
    // The client sent "1.1.1.1" itself; our single proxy appended the address it saw.
    expect(clientIpFromHeaders(xff('1.1.1.1, 198.51.100.7'), 1)).toBe('198.51.100.7');
  });

  it('is null for 0 hops or without the header', () => {
    expect(clientIpFromHeaders(xff('203.0.113.9'), 0)).toBeNull();
    expect(clientIpFromHeaders(xff('203.0.113.9'), -1)).toBeNull();
    expect(clientIpFromHeaders(xff('203.0.113.9'), Number.NaN)).toBeNull();
    expect(clientIpFromHeaders(new Headers(), 1)).toBeNull();
    expect(clientIpFromHeaders(new Headers({ 'X-Real-IP': '203.0.113.9' }), 1)).toBeNull();
  });

  it('treats several X-Forwarded-For headers as one list', () => {
    const h = xff('203.0.113.9', '10.0.0.2, 10.0.0.1');
    expect(h.get('x-forwarded-for')).toBe('203.0.113.9, 10.0.0.2, 10.0.0.1');
    expect(clientIpFromHeaders(h, 1)).toBe('10.0.0.1');
    expect(clientIpFromHeaders(h, 3)).toBe('203.0.113.9');
  });

  it('trims entries and ignores empty ones', () => {
    expect(clientIpFromHeaders(xff('  203.0.113.9  ,,  10.0.0.1 , '), 1)).toBe('10.0.0.1');
    expect(clientIpFromHeaders(xff('  203.0.113.9  ,,  10.0.0.1 , '), 2)).toBe('203.0.113.9');
    expect(clientIpFromHeaders(xff(''), 1)).toBeNull();
    expect(clientIpFromHeaders(xff(' , ,'), 1)).toBeNull();
  });

  it('removes ports', () => {
    expect(clientIpFromHeaders(xff('203.0.113.9:54321'), 1)).toBe('203.0.113.9');
    expect(clientIpFromHeaders(xff('[2001:db8::1]:443'), 1)).toBe('2001:db8::1');
    expect(clientIpFromHeaders(xff('[::1]:123'), 1)).toBe('::1');
    expect(clientIpFromHeaders(xff('[::1]'), 1)).toBe('::1');
  });

  it('accepts IPv6 forms and lowercases them', () => {
    expect(clientIpFromHeaders(xff('2001:DB8::A'), 1)).toBe('2001:db8::a');
    expect(clientIpFromHeaders(xff('::'), 1)).toBe('::');
    expect(clientIpFromHeaders(xff('::1'), 1)).toBe('::1');
    expect(clientIpFromHeaders(xff('2001:db8:0:0:0:0:0:1'), 1)).toBe('2001:db8:0:0:0:0:0:1');
    expect(clientIpFromHeaders(xff('::ffff:203.0.113.9'), 1)).toBe('::ffff:203.0.113.9');
    expect(clientIpFromHeaders(xff('fe80::1%eth0'), 1)).toBe('fe80::1%eth0');
    expect(clientIpFromHeaders(xff('1::'), 1)).toBe('1::');
    expect(clientIpFromHeaders(xff('1:2:3:4:5:6:7::'), 1)).toBe('1:2:3:4:5:6:7::');
    expect(clientIpFromHeaders(xff('1:2:3:4:5:6:192.0.2.1'), 1)).toBe('1:2:3:4:5:6:192.0.2.1');
    expect(clientIpFromHeaders(xff('[::FFFF:192.0.2.1]:8080'), 1)).toBe('::ffff:192.0.2.1');
  });

  it.each([
    'unknown',
    '_hidden',
    'example.com',
    '256.1.1.1',
    '1.2.3',
    '1.2.3.4.5',
    '01.2.3.4',
    '1.2.3.4:',
    '1.2.3.4:port',
    '1.2.3.4:123456',
    '[1.2.3.4]:80',
    '[::1',
    '2001:db8::1:80:x',
    '1:2:3:4:5:6:7',
    '1:2:3:4:5:6:7:8:9',
    '1::2::3',
    ':1::2',
    '1::2:',
    ':::',
    '12345::1',
    '1:2:3:4:5:6:7:8::',
    '1:2:3:4:5:6:7:192.0.2.1',
    '1:2:3:4:5:6::192.0.2.1',
    '192.0.2.1::',
    '::ffff:1.2.3.256',
    'fe80::1%',
    '2001:db8::1 extra',
    '<script>',
  ])('rejects %j', (entry) => {
    expect(clientIpFromHeaders(xff(entry), 1)).toBeNull();
  });

  it('only validates the chosen entry', () => {
    expect(clientIpFromHeaders(xff('garbage, 10.0.0.1'), 1)).toBe('10.0.0.1');
    expect(clientIpFromHeaders(xff('10.0.0.2, garbage'), 1)).toBeNull();
  });

  it('floors a fractional hop count', () => {
    expect(clientIpFromHeaders(xff('203.0.113.9, 10.0.0.2, 10.0.0.1'), 2.7)).toBe('10.0.0.2');
  });
});
