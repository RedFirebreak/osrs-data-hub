'use client';
/**
 * Header navigation: inline links from `md` up (MainNav), a menu button below (MobileNav). The
 * current section is highlighted and marked `aria-current="page"`.
 */
import { MenuIcon } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { isNavActive, navItemsFor } from './nav-items';

export function MainNav({ isAdmin, className }: { isAdmin: boolean; className?: string }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className={cn('hidden items-center gap-1 lg:flex', className)}>
      {navItemsFor(isAdmin).map((item) => {
        const active = isNavActive(pathname, item.href);
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-sm whitespace-nowrap font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
              active && 'bg-muted text-foreground',
            )}
          >
            <Icon aria-hidden className="size-4" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

export function MobileNav({ isAdmin, className }: { isAdmin: boolean; className?: string }) {
  const pathname = usePathname();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className={cn('lg:hidden', className)}>
          <MenuIcon aria-hidden />
          <span className="sr-only">Open navigation</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-52">
        {navItemsFor(isAdmin).map((item) => {
          const active = isNavActive(pathname, item.href);
          const Icon = item.icon;
          return (
            <DropdownMenuItem key={item.href} asChild className={cn(active && 'bg-muted')}>
              <Link href={item.href} aria-current={active ? 'page' : undefined}>
                <Icon aria-hidden />
                {item.label}
              </Link>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
