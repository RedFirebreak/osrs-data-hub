'use client';
/**
 * The header's navigation: a few links that fit at every width, so there is no separate menu on
 * phones. The current section is highlighted and marked `aria-current="page"`.
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { NAV_ITEMS, isNavActive } from './nav-items';

export interface MainNavProps {
  /** Public ids of the viewer's own characters: their pages count as Home (isNavActive). */
  ownAccountIds: readonly string[];
  className?: string;
}

export function MainNav({ ownAccountIds, className }: MainNavProps) {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className={cn('flex items-center gap-0.5', className)}>
      {NAV_ITEMS.map((item) => {
        const active = isNavActive(pathname, item.href, ownAccountIds);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'pressable inline-flex h-8 items-center rounded-full px-3 text-sm font-medium whitespace-nowrap text-muted-foreground hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
              active && 'bg-muted text-foreground',
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
