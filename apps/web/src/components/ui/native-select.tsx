/**
 * The browser's own <select>, styled like Input: for long or grouped lists (time zones) and for
 * small forms where the platform's picker is the better one (a key's expiry). The Radix Select
 * (select.tsx) is the one with custom items. Hand-written (not a shadcn component).
 */
import * as React from 'react';
import { cn } from 'cn';

function NativeSelect({ className, ...props }: React.ComponentProps<'select'>) {
  return (
    <select
      className={cn(
        'h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive dark:bg-input/30 [&_option]:bg-popover',
        className,
      )}
      {...props}
    />
  );
}

export { NativeSelect };
