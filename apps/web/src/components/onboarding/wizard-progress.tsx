/**
 * The wizard's 4-step progress indicator (Install → Pair → First data → Done): a bar per step, filled
 * up to the current one, with its number (a check once done) and label. The current step carries
 * aria-current="step"; done and upcoming steps say so to screen readers. Server- and client-safe.
 */
import { CheckIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { WIZARD_STEPS, type WizardStep } from './wizard-model';

export function WizardProgress({ current }: { current: WizardStep }) {
  return (
    <ol aria-label="Setup progress" className="grid grid-cols-4 gap-2 sm:gap-3">
      {WIZARD_STEPS.map(({ step, label }) => {
        const done = step < current;
        const active = step === current;
        return (
          <li
            key={step}
            aria-current={active ? 'step' : undefined}
            className="flex min-w-0 flex-col gap-2"
          >
            <span
              aria-hidden
              className={cn(
                'h-1.5 rounded-full transition-colors',
                done || active ? 'bg-primary' : 'bg-muted',
              )}
            />
            <span className="flex min-w-0 items-center gap-1.5 text-xs sm:text-sm">
              <span
                aria-hidden
                className={cn(
                  'hidden size-5 shrink-0 items-center justify-center rounded-full border text-[0.7rem] font-medium tabular-nums min-[420px]:flex',
                  done && 'border-primary bg-primary text-primary-foreground',
                  active && 'border-primary text-foreground',
                  !done && !active && 'text-muted-foreground',
                )}
              >
                {done ? <CheckIcon className="size-3" /> : step}
              </span>
              <span
                className={cn(
                  'truncate',
                  active ? 'font-medium text-foreground' : 'text-muted-foreground',
                )}
              >
                <span className="sr-only">Step {step}: </span>
                {label}
                <span className="sr-only">{done ? ' (done)' : active ? ' (current)' : ''}</span>
              </span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
