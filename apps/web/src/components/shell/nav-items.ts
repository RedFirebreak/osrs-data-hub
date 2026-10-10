/**
 * Where the header's links go. The top bar holds what a player comes for (Home, Progress, Guild);
 * the pages someone visits once to set things up sit in the avatar menu, with Admin for admins only
 * (the admin pages also answer 404 to everyone else, requireAdmin).
 */
import {
  KeyRoundIcon,
  MonitorSmartphoneIcon,
  SettingsIcon,
  ShieldCheckIcon,
  ShieldIcon,
  type LucideIcon,
} from 'lucide-react';
import type { Route } from 'next';

export interface NavItem {
  href: Route;
  label: string;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { href: '/', label: 'Home' },
  { href: '/guild', label: 'Guild' },
];

export interface MenuItem extends NavItem {
  icon: LucideIcon;
  adminOnly?: boolean;
}

export const ACCOUNT_MENU_ITEMS: readonly MenuItem[] = [
  { href: '/devices', label: 'Devices', icon: MonitorSmartphoneIcon },
  { href: '/api-keys', label: 'API keys', icon: KeyRoundIcon },
  { href: '/settings', label: 'Settings', icon: SettingsIcon },
  { href: '/privacy', label: 'Privacy', icon: ShieldCheckIcon },
  { href: '/admin', label: 'Admin', icon: ShieldIcon, adminOnly: true },
];

/** The avatar menu's page links for this user. */
export function accountMenuItemsFor(isAdmin: boolean): MenuItem[] {
  return ACCOUNT_MENU_ITEMS.filter((item) => !item.adminOnly || isAdmin);
}

/** The public id of the character page `pathname` is, or null. */
function characterOf(pathname: string): string | null {
  return /^\/accounts\/([^/]+)$/.exec(pathname)?.[1] ?? null;
}

/**
 * Whether `href` is the current section. A character page belongs to Home when the character is one
 * of the viewer's own (`ownAccountIds`) and to Guild otherwise; everything else is its own path or
 * anything below it.
 */
export function isNavActive(
  pathname: string | null,
  href: string,
  ownAccountIds: readonly string[] = [],
): boolean {
  if (pathname === null) return false;
  const character = characterOf(pathname);
  if (character !== null && (href === '/' || href === '/guild')) {
    return ownAccountIds.includes(character) === (href === '/');
  }
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}
