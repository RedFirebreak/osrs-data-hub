/** The hub's small logo mark (header, login, public pages). Decorative. */
import { ActivityIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export function HubMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground',
        className,
      )}
    >
      <ActivityIcon className="size-4" />
    </span>
  );
}
