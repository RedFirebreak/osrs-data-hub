import { describe, expect, it } from 'vitest';
import { isNavActive, navItemsFor } from './nav-items';

describe('navigation', () => {
  it('shows Admin to admins only', () => {
    expect(navItemsFor(false).map((i) => i.label)).toEqual([
      'Dashboard',
      'Guild',
      'Devices',
      'API keys',
      'Settings',
    ]);
    expect(navItemsFor(true).map((i) => i.label)).toContain('Admin');
  });

  it('marks the current section', () => {
    expect(isNavActive('/', '/')).toBe(true);
    expect(isNavActive('/devices', '/')).toBe(false);
    expect(isNavActive('/devices', '/devices')).toBe(true);
    expect(isNavActive('/admin/users', '/admin')).toBe(true);
    expect(isNavActive('/administrator', '/admin')).toBe(false);
    expect(isNavActive('/api-keys', '/api-keys')).toBe(true);
    expect(isNavActive(null, '/')).toBe(false);
  });
});
