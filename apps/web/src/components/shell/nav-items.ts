/**
 * The app's main navigation (header on desktop, menu on phones). Admin is listed for admins only;
 * the admin pages also answer 404 to everyone else (requireAdmin).
 */
import {
  KeyRoundIcon,
  LayoutDashboardIcon,
  MonitorSmartphoneIcon,
  SettingsIcon,
  ShieldIcon,
  UsersIcon,
  type LucideIcon,
} from 'lucide-react';
import type { Route } from 'next';

export interface NavItem {
  href: Route;
  label: string;
  icon: LucideIcon;
  adminOnly?: boolean;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboardIcon },
  { href: '/guild', label: 'Guild', icon: UsersIcon },
  { href: '/devices', label: 'Devices', icon: MonitorSmartphoneIcon },
  { href: '/api-keys', label: 'API keys', icon: KeyRoundIcon },
  { href: '/settings', label: 'Settings', icon: SettingsIcon },
  { href: '/admin', label: 'Admin', icon: ShieldIcon, adminOnly: true },
];

/** The items this user sees. */
export function navItemsFor(isAdmin: boolean): NavItem[] {
  return NAV_ITEMS.filter((item) => !item.adminOnly || isAdmin);
}

/** Whether `href` is the current section: exact for '/', else the path or anything below it. */
export function isNavActive(pathname: string | null, href: string): boolean {
  if (pathname === null) return false;
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}
