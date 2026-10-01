/**
 * A page that is only a message: an icon in a circle, a heading, a sentence or two and the way out
 * (not found, something went wrong). Server- and client-safe (app/error.tsx is a client component).
 *
 *   <StatusPage
 *     icon={CompassIcon}
 *     eyebrow="404"
 *     title="Page not found"
 *     actions={<Button asChild><Link href="/">Go to the dashboard</Link></Button>}
 *   >
 *     This page doesn&apos;t exist, or it isn&apos;t shared with you.
 *   </StatusPage>
 *
 * Inside the signed-in layout it is a block in that layout's <main>; `standalone` makes it the page's
 * own <main id="main"> (the root not-found and error pages, which render without that layout).
 * `StatusIcon` is the icon circle on its own, for an empty state inside a card.
 */
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface StatusIconProps {
  icon: LucideIcon;
  /** `destructive` for an error; the default is the muted circle. */
  tone?: 'muted' | 'destructive';
}

/** The icon in its circle (decorative: the text beside it says what happened). */
export function StatusIcon({ icon: Icon, tone = 'muted' }: StatusIconProps) {
  return (
    <span
      aria-hidden
      className={cn(
        'flex size-12 items-center justify-center rounded-full',
        tone === 'destructive'
          ? 'bg-destructive/10 text-destructive'
          : 'bg-muted text-muted-foreground',
      )}
    >
      <Icon className="size-6" />
    </span>
  );
}

export interface StatusPageProps extends StatusIconProps {
  /** The page's h1. */
  title: string;
  /** A small line above the title ("404"). */
  eyebrow?: string;
  /** The explanation under the title. */
  children: React.ReactNode;
  /** The way out: a button, or a row of them. */
  actions: React.ReactNode;
  /** Render as the page's own <main id="main"> (outside the signed-in layout). */
  standalone?: boolean;
  /** Announce the title and explanation as an alert (an error that replaced the page). */
  alert?: boolean;
}

export function StatusPage({
  icon,
  tone,
  title,
  eyebrow,
  children,
  actions,
  standalone = false,
  alert = false,
}: StatusPageProps) {
  const content = (
    <>
      <StatusIcon icon={icon} tone={tone} />
      {/* The alert role on the content: <main> may not change its role (it stays the landmark). */}
      <div role={alert ? 'alert' : undefined} className="flex flex-col gap-1">
        {eyebrow && <p className="text-sm font-medium text-muted-foreground">{eyebrow}</p>}
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="max-w-md text-sm text-balance text-muted-foreground">{children}</p>
      </div>
      {actions}
    </>
  );
  return standalone ? (
    <main
      id="main"
      className="flex min-h-[60dvh] flex-1 flex-col items-center justify-center gap-4 px-4 py-16 text-center"
    >
      {content}
    </main>
  ) : (
    <div className="flex min-h-[50dvh] flex-col items-center justify-center gap-4 px-4 py-12 text-center">
      {content}
    </div>
  );
}
