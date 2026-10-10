import { describe, expect, it } from 'vitest';
import { NAV_ITEMS, accountMenuItemsFor, isNavActive } from './nav-items';

describe('navigation', () => {
  it('keeps the top bar to what a player comes for', () => {
    expect(NAV_ITEMS.map((i) => i.label)).toEqual(['Home', 'Guild']);
  });

  it('puts the set-up pages in the avatar menu, with Admin for admins only', () => {
    expect(accountMenuItemsFor(false).map((i) => i.label)).toEqual([
      'Devices',
      'API keys',
      'Settings',
      'Privacy',
    ]);
    expect(accountMenuItemsFor(true).map((i) => i.label)).toContain('Admin');
  });

  it('marks the current section', () => {
    expect(isNavActive('/', '/')).toBe(true);
    expect(isNavActive('/guild', '/')).toBe(false);
    expect(isNavActive('/guild', '/guild')).toBe(true);
    expect(isNavActive('/guildhall', '/guild')).toBe(false);
    expect(isNavActive('/devices', '/')).toBe(false);
    expect(isNavActive('/devices', '/guild')).toBe(false);
    expect(isNavActive(null, '/')).toBe(false);
  });

  it("counts the viewer's own characters as Home and everyone else's as Guild", () => {
    const own = ['mine12345678'];
    expect(isNavActive('/accounts/mine12345678', '/', own)).toBe(true);
    expect(isNavActive('/accounts/mine12345678', '/guild', own)).toBe(false);
    expect(isNavActive('/accounts/theirs123456', '/', own)).toBe(false);
    expect(isNavActive('/accounts/theirs123456', '/guild', own)).toBe(true);
  });
});
