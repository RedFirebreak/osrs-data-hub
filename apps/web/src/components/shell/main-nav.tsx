'use client';
/**
 * The header's navigation: a few links that fit at every width, so there is no separate menu on
 * phones. The current section is highlighted and marked `aria-current="page"`. While an admin has the
 * live map linked (D-115), "Map" follows Guild: another site, so it opens in a new tab and says so
 * with an arrow.
 */
import { ArrowUpRightIcon } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { NAV_ITEMS, isNavActive } from './nav-items';

export interface MainNavProps {
  /** Public ids of the viewer's own characters: their pages count as Home (isNavActive). */
  ownAccountIds: readonly string[];
  /** The live map's address while its link is on, else null (no "Map"). */
  mapHref?: string | null;
  className?: string;
}

const ITEM_CLASS =
  'pressable inline-flex h-8 items-center rounded-full text-sm font-medium whitespace-nowrap text-muted-foreground hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none';

export function MainNav({ ownAccountIds, mapHref = null, className }: MainNavProps) {
  const pathname = usePathname();
  // Four links sit tighter on a phone so the header still fits 360 px; three keep their room.
  const tight = mapHref !== null;
  const itemClass = cn(ITEM_CLASS, tight ? 'px-2 sm:px-3' : 'px-3');
  return (
    <nav
      aria-label="Main"
      className={cn('flex items-center', tight ? 'sm:gap-0.5' : 'gap-0.5', className)}
    >
      {NAV_ITEMS.map((item) => {
        const active = isNavActive(pathname, item.href, ownAccountIds);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={cn(itemClass, active && 'bg-muted text-foreground')}
          >
            {item.label}
          </Link>
        );
      })}
      {mapHref !== null && (
        <a
          href={mapHref}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(itemClass, 'sm:gap-0.5')}
        >
          Map
          <ArrowUpRightIcon aria-hidden className="size-3 sm:size-3.5" />
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      )}
    </nav>
  );
}
