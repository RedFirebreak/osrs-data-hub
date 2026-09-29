'use client';
/**
 * The admin area's section tabs (handoff §12 Admin), one page each. Links, so every section has its
 * own URL and works without JavaScript; the row scrolls sideways on phones.
 */
import {
  ActivityIcon,
  FileJsonIcon,
  MonitorSmartphoneIcon,
  PowerIcon,
  ScrollTextIcon,
  SlidersHorizontalIcon,
  UsersIcon,
  type LucideIcon,
} from 'lucide-react';
import type { Route } from 'next';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { isAdminTabActive } from './admin-model';

export const ADMIN_TABS: readonly { href: Route; label: string; icon: LucideIcon }[] = [
  { href: '/admin', label: 'Users', icon: UsersIcon },
  { href: '/admin/devices', label: 'Devices', icon: MonitorSmartphoneIcon },
  { href: '/admin/ingest', label: 'Ingest health', icon: ActivityIcon },
  { href: '/admin/payloads', label: 'Raw payloads', icon: FileJsonIcon },
  { href: '/admin/audit', label: 'Audit log', icon: ScrollTextIcon },
  { href: '/admin/config', label: 'Configuration', icon: SlidersHorizontalIcon },
  { href: '/admin/decommission', label: 'Decommission', icon: PowerIcon },
];

export function AdminNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Admin sections" className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <ul className="flex w-max min-w-full gap-1 border-b">
        {ADMIN_TABS.map(({ href, label, icon: Icon }) => {
          const active = isAdminTabActive(pathname, href);
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  '-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors outline-none focus-visible:rounded-md focus-visible:ring-3 focus-visible:ring-ring/50',
                  active
                    ? 'border-foreground text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground',
                )}
              >
                <Icon aria-hidden className="size-4" />
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
