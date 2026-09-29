'use client';
/**
 * "Copy" button for the pairing code and the hub URL: copies `value` exactly as given (the code as a
 * string with its leading zeros, PLUGIN-6; the URL with its https://, PLUGIN-13), confirms with
 * "Copied" for two seconds and announces the result to screen readers. Falls back to a hidden
 * textarea where the Clipboard API is unavailable (plain http outside localhost).
 */
import { CheckIcon, CopyIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface CopyButtonProps {
  value: string;
  /** What is copied, for the accessible name ("Copy pairing code"). */
  what: string;
  disabled?: boolean;
  className?: string;
}

const FEEDBACK_MS = 2_000;

async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Permission denied or not a secure context: try the fallback.
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

export function CopyButton({ value, what, disabled, className }: CopyButtonProps) {
  const [result, setResult] = useState<'copied' | 'failed' | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  async function copy(): Promise<void> {
    const ok = await copyText(value);
    setResult(ok ? 'copied' : 'failed');
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => setResult(null), FEEDBACK_MS);
  }

  const copied = result === 'copied';
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={() => void copy()}
        aria-label={`Copy ${what}`}
        className={cn('min-w-22', className)}
      >
        {copied ? (
          <CheckIcon aria-hidden data-icon="inline-start" className="text-emerald-600" />
        ) : (
          <CopyIcon aria-hidden data-icon="inline-start" />
        )}
        {copied ? 'Copied' : 'Copy'}
      </Button>
      <span className="sr-only" role="status">
        {result === 'copied'
          ? `${what} copied to the clipboard`
          : result === 'failed'
            ? `Couldn't copy the ${what}: select it and copy it by hand`
            : ''}
      </span>
    </>
  );
}
