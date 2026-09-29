/**
 * The online indicator next to an account name: a green (pulsing) dot when online, a grey one when
 * offline, and a hollow one when unknown (the viewer can't see the account's activity, or it was
 * never sent). Carries screen-reader text; pass `label` to change it. Server- and client-safe.
 *
 * For a dot that follows live presence messages, use <AccountPresence> (it renders this).
 */
import { cn } from '@/lib/utils';

export interface OnlineDotProps {
  /** true online, false offline, null unknown / not shared. */
  online: boolean | null;
  /** Screen-reader text; defaults to "Online", "Offline" or "Online status unknown". */
  label?: string;
  /** Pulse while online (default true; turn it off in long lists). */
  pulse?: boolean;
  className?: string;
}

export function OnlineDot({ online, label, pulse = true, className }: OnlineDotProps) {
  const text = label ?? (online === null ? 'Online status unknown' : online ? 'Online' : 'Offline');
  return (
    <span
      className={cn('relative inline-flex size-2.5 shrink-0', className)}
      data-online={online === null ? 'unknown' : String(online)}
    >
      {online === true && pulse && (
        <span
          aria-hidden
          className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-60 motion-reduce:hidden"
        />
      )}
      <span
        aria-hidden
        className={cn(
          'relative inline-flex size-full rounded-full',
          online === true && 'bg-emerald-500',
          online === false && 'bg-muted-foreground/40',
          online === null && 'border border-dashed border-muted-foreground/60',
        )}
      />
      <span className="sr-only">{text}</span>
    </span>
  );
}
