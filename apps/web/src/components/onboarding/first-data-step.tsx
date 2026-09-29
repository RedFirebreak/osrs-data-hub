'use client';
/**
 * Wizard step 3 (handoff §6.3): RuneLite is connected; the player logs in to OSRS and the wizard waits
 * for the first payload from this device ('device' live message, or the polling fallback), then shows
 * "Receiving data for Zezima (Ironman)" and whether the user became the owner or a contributor.
 * Leagues, Deadman and other special worlds send nothing by default (D-1), hence the hint.
 */
import type { DeviceFirstData } from '@hub/server';
import { accountTypeLabel } from '@hub/core';
import { ArrowRightIcon, CircleCheckIcon, LoaderCircleIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { StepHeading } from './step-heading';
import { POLL_INTERVAL_MS, describeRole } from './wizard-model';

export interface FirstDataStepProps {
  firstData: DeviceFirstData | null;
  connected: boolean;
  onContinue(): void;
  headingRef?: React.Ref<HTMLHeadingElement>;
}

/** "Ironman" for ironman types, null for unknown ones (nothing in brackets then). */
function typeLabel(accountType: number | null): string | null {
  const label = accountTypeLabel(accountType);
  return label === 'Unknown' ? null : label;
}

export function FirstDataStep({
  firstData,
  connected,
  onContinue,
  headingRef,
}: FirstDataStepProps) {
  const type = firstData ? typeLabel(firstData.account.accountType) : null;
  return (
    <div className="flex flex-col gap-6">
      <p
        role="status"
        className="flex items-center gap-2 text-sm font-medium text-emerald-700 dark:text-emerald-400"
      >
        <CircleCheckIcon aria-hidden className="size-4" />
        RuneLite connected
      </p>

      <StepHeading
        step={3}
        headingRef={headingRef}
        title="Log in to see your first data"
        description="Log in to OSRS with any account (not on a Leagues/Deadman world)."
      />

      <div
        role="status"
        className="flex min-h-24 flex-col justify-center gap-1 rounded-xl bg-muted/40 p-4 ring-1 ring-foreground/10"
      >
        {firstData ? (
          <>
            <p className="flex flex-wrap items-center gap-x-2 text-base">
              <CircleCheckIcon
                aria-hidden
                className="size-5 text-emerald-600 dark:text-emerald-400"
              />
              <span>
                Receiving data for{' '}
                <strong className="font-semibold">{firstData.account.name}</strong>
                {type && <span className="text-muted-foreground"> ({type})</span>}
              </span>
            </p>
            <p className="text-sm text-muted-foreground">{describeRole(firstData)}</p>
          </>
        ) : (
          <>
            <p className="flex items-center gap-2 text-sm">
              <LoaderCircleIcon aria-hidden className="size-4 animate-spin motion-reduce:hidden" />
              Waiting for the first data from this device…
            </p>
            <p className="text-xs text-muted-foreground">
              It arrives a few seconds after you log in.
              {!connected &&
                ` Live updates are reconnecting; checking every ${POLL_INTERVAL_MS / 1000} seconds.`}
            </p>
          </>
        )}
      </div>

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end">
        {!firstData && (
          <Button type="button" variant="ghost" onClick={onContinue}>
            Skip for now
          </Button>
        )}
        <Button type="button" size="lg" onClick={onContinue} disabled={!firstData}>
          Continue
          <ArrowRightIcon aria-hidden data-icon="inline-end" />
        </Button>
      </div>
    </div>
  );
}
