/**
 * Links to an account page (/accounts/<publicId>, D-46 public ids). `accountHref` is the one place
 * that builds the URL (typedRoutes: a dynamic string needs the `Route` cast). Server- and client-safe.
 */
import type { Route } from 'next';
import Link from 'next/link';
import { cn } from '@/lib/utils';

/** The account page URL for a public id. */
export function accountHref(publicId: string): Route {
  return `/accounts/${encodeURIComponent(publicId)}` as Route;
}

export interface AccountLinkProps {
  publicId: string;
  /** Link text; defaults to children. */
  name?: string;
  children?: React.ReactNode;
  className?: string;
}

/** The account's name (or children) linking to its page. */
export function AccountLink({ publicId, name, children, className }: AccountLinkProps) {
  return (
    <Link
      href={accountHref(publicId)}
      className={cn(
        'font-medium underline-offset-4 hover:underline focus-visible:underline',
        className,
      )}
    >
      {children ?? name}
    </Link>
  );
}
