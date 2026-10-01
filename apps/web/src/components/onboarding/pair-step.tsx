'use client';
/**
 * Wizard step 2 (handoff §6.2, §6.3): the 5-digit code in large monospace digits and the hub's full
 * base URL, each with a copy button, a countdown to the code's expiry with Regenerate, and the live
 * status: waiting, the outdated-plugin alert, and troubleshooting once the user has pressed Submit
 * and nothing arrived for 60 s.
 *
 * The URL is shown exactly as the hub's APP_URL origin, scheme included: the plugin fails silently on
 * a URL without https:// (PLUGIN-13). The code stays a string throughout (PLUGIN-6). The code box
 * keeps its size while loading, expired or regenerated, so nothing below it jumps.
 */
import {
  AlertTriangleIcon,
  ArrowLeftIcon,
  CircleHelpIcon,
  LoaderCircleIcon,
  RefreshCwIcon,
  SendIcon,
} from 'lucide-react';
import { useId, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { CopyButton } from './copy-button';
import { StepHeading } from './step-heading';
import {
  POLL_INTERVAL_MS,
  describeCountdown,
  formatCountdown,
  schemeOf,
  spellDigits,
  type WizardCode,
} from './wizard-model';

export interface PairStepProps {
  code: WizardCode | null;
  codeRequest: 'idle' | 'loading' | 'failed';
  codeError: string | null;
  /** The code in the URL is being looked up after a reload (loading, but not creating one). */
  resuming: boolean;
  /** Milliseconds left on the code; null before the browser clock runs (hydration). */
  msLeft: number | null;
  expired: boolean;
  /** The live stream is open (otherwise the wizard polls every 3 s). */
  connected: boolean;
  /** Show the outdated-plugin alert, with the version the hub saw (null: none sent). */
  outdated: { version: string | null } | null;
  /** Seconds left of the "I pressed Submit" wait, or null. */
  waitSecondsLeft: number | null;
  troubleshooting: boolean;
  minPluginVersion: string;
  onRegenerate(): void;
  onSubmitted(): void;
  onBack(): void;
  headingRef?: React.Ref<HTMLHeadingElement>;
}

const CODE_LENGTH = 5;

/** 300_000 → "5 minutes", 90_000 → "90 seconds". */
function lifetimeText(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds % 60 === 0) {
    const minutes = seconds / 60;
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  }
  return `${seconds} seconds`;
}

export function PairStep(props: PairStepProps) {
  const {
    code,
    codeRequest,
    codeError,
    resuming,
    msLeft,
    expired,
    connected,
    outdated,
    waitSecondsLeft,
    troubleshooting,
    minPluginVersion,
    onRegenerate,
    onSubmitted,
    onBack,
    headingRef,
  } = props;
  const id = useId();
  const [tipsOpen, setTipsOpen] = useState(false);
  const loading = codeRequest === 'loading';
  const failed = codeRequest === 'failed' && !loading;
  const usable = code !== null && !loading && !expired;
  const scheme = code ? schemeOf(code.baseUrl) : 'https://';

  return (
    <div className="flex flex-col gap-6">
      <StepHeading
        step={2}
        headingRef={headingRef}
        title="Pair RuneLite with the hub"
        description="Enter this code and URL in the HA Exporter panel."
      />

      <ol className="flex flex-col gap-2 text-sm">
        {[
          <>
            In RuneLite, open the <strong>HA Exporter</strong> panel from the sidebar and click{' '}
            <strong>Connect New Device</strong>.
          </>,
          <>Enter the 5-digit code.</>,
          <>
            Paste the URL into <strong>Endpoint URL</strong>.
          </>,
          <>
            Press <strong>Submit</strong>.
          </>,
        ].map((text, i) => (
          <li key={i} className="flex gap-3">
            <span
              aria-hidden
              className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium tabular-nums"
            >
              {i + 1}
            </span>
            <span className="pt-0.5 text-pretty">{text}</span>
          </li>
        ))}
      </ol>

      <section
        aria-labelledby={`${id}-code-label`}
        className="flex flex-col gap-3 rounded-xl bg-muted/40 p-4 ring-1 ring-foreground/10"
      >
        <h3 id={`${id}-code-label`} className="text-sm font-medium">
          Pairing code
        </h3>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <div
            data-testid="pairing-code"
            data-code={code && !loading ? code.code : undefined}
            className="flex gap-1.5 sm:gap-2"
          >
            {Array.from({ length: CODE_LENGTH }, (_, i) => (
              <span
                key={i}
                aria-hidden
                className={cn(
                  // 5 × w-10 + 4 gaps = 224 px: fits a 320 px phone inside the page, card and
                  // section padding; w-11 from 360 px up.
                  'flex h-14 w-10 items-center justify-center rounded-lg border bg-background font-mono text-3xl font-semibold tabular-nums min-[360px]:w-11 sm:h-16 sm:w-13 sm:text-4xl',
                  loading && 'animate-pulse bg-muted',
                  expired && 'text-muted-foreground line-through decoration-2',
                )}
              >
                {code && !loading ? code.code[i] : ''}
              </span>
            ))}
          </div>
          <span className="sr-only">
            {loading
              ? resuming
                ? 'Loading your code.'
                : 'Creating a code.'
              : code
                ? `Code: ${spellDigits(code.code)}${expired ? ' (expired)' : ''}`
                : 'No code yet.'}
          </span>
          <div className="flex flex-wrap items-center gap-2">
            <CopyButton value={code?.code ?? ''} what="pairing code" disabled={!usable} />
            <Button
              type="button"
              size="sm"
              variant={expired ? 'default' : 'ghost'}
              onClick={onRegenerate}
              disabled={loading}
            >
              <RefreshCwIcon
                aria-hidden
                data-icon="inline-start"
                className={cn(loading && 'animate-spin')}
              />
              Regenerate
            </Button>
          </div>
        </div>
        <p className="flex h-5 items-center gap-1.5 text-sm">
          {loading ? (
            <span className="text-muted-foreground">
              {resuming ? 'Loading your code…' : 'Creating a code…'}
            </span>
          ) : expired ? (
            <span className="font-medium text-destructive">Code expired</span>
          ) : code ? (
            <>
              <span aria-hidden className="text-muted-foreground">
                Expires in{' '}
                <span className="font-medium text-foreground tabular-nums">
                  {msLeft === null ? '--:--' : formatCountdown(msLeft)}
                </span>
              </span>
              {msLeft !== null && (
                <span className="sr-only">Expires in {describeCountdown(msLeft)}</span>
              )}
            </>
          ) : null}
        </p>
      </section>

      <section
        aria-labelledby={`${id}-url-label`}
        className="flex flex-col gap-3 rounded-xl bg-muted/40 p-4 ring-1 ring-foreground/10"
      >
        <h3 id={`${id}-url-label`} className="text-sm font-medium">
          Endpoint URL
        </h3>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <code
            data-testid="pairing-url"
            className="min-h-9 flex-1 rounded-lg border bg-background px-3 py-2 font-mono text-sm break-all"
          >
            {code?.baseUrl ?? ' '}
          </code>
          <CopyButton value={code?.baseUrl ?? ''} what="hub URL" disabled={!code} />
        </div>
        <p className="text-sm text-muted-foreground">
          Copy the URL exactly, including <span className="font-mono">{scheme}</span>. Without it,
          Submit silently does nothing in the plugin.
        </p>
      </section>

      <div className="flex flex-col gap-3">
        {failed && (
          <Alert variant="destructive">
            <AlertTriangleIcon aria-hidden />
            <AlertTitle>Couldn&apos;t create a pairing code</AlertTitle>
            <AlertDescription>
              <p>{codeError ?? 'Try again in a moment.'}</p>
              <Button type="button" size="sm" variant="outline" onClick={onRegenerate}>
                Try again
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {expired && !failed && (
          <Alert>
            <AlertTriangleIcon aria-hidden />
            <AlertTitle>Get a new code</AlertTitle>
            <AlertDescription>
              {`A code is valid for ${code ? lifetimeText(code.lifetimeMs) : 'a few minutes'}. `}
              Press Regenerate, then enter the new code in the plugin.
            </AlertDescription>
          </Alert>
        )}

        {outdated && usable && (
          <Alert className="border-amber-500/40 bg-amber-500/5">
            <AlertTriangleIcon aria-hidden className="text-amber-600 dark:text-amber-400" />
            <AlertTitle>Update HA Exporter</AlertTitle>
            <AlertDescription>
              {`Your HA Exporter is too old (${outdated.version ? `version ${outdated.version}` : 'no version sent'}). `}
              Restart RuneLite to update it, then press Submit again. The hub needs version{' '}
              {minPluginVersion} or newer.
            </AlertDescription>
          </Alert>
        )}

        {usable && !outdated && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <LoaderCircleIcon aria-hidden className="size-4 animate-spin motion-reduce:hidden" />
            <p>
              {/* The live region holds only the steady text: the seconds change every second and
                  would be announced every second. The troubleshooting alert follows at 0. */}
              <span role="status">Waiting for RuneLite to connect…</span>
              {waitSecondsLeft !== null && (
                <span aria-hidden className="tabular-nums">{` (${waitSecondsLeft} s)`}</span>
              )}
              {!connected && (
                <span className="block text-xs">
                  Live updates are reconnecting; checking every {POLL_INTERVAL_MS / 1000} seconds.
                </span>
              )}
            </p>
          </div>
        )}

        {usable && (troubleshooting || tipsOpen) && (
          <Troubleshooting
            id={`${id}-tips`}
            auto={troubleshooting}
            scheme={scheme}
            minPluginVersion={minPluginVersion}
          />
        )}
      </div>

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
        <Button type="button" variant="ghost" onClick={onBack}>
          <ArrowLeftIcon aria-hidden data-icon="inline-start" />
          Back
        </Button>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center">
          {!troubleshooting && (
            <Button
              type="button"
              variant="ghost"
              aria-expanded={tipsOpen}
              aria-controls={tipsOpen ? `${id}-tips` : undefined}
              onClick={() => setTipsOpen((open) => !open)}
              disabled={!usable}
            >
              <CircleHelpIcon aria-hidden data-icon="inline-start" />
              Having trouble?
            </Button>
          )}
          <Button type="button" size="lg" onClick={onSubmitted} disabled={!usable}>
            <SendIcon aria-hidden data-icon="inline-start" />
            {waitSecondsLeft !== null || troubleshooting
              ? 'I pressed Submit again'
              : 'I pressed Submit'}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Troubleshooting({
  id,
  auto,
  scheme,
  minPluginVersion,
}: {
  id: string;
  /** Shown because nothing arrived 60 s after "I pressed Submit". */
  auto: boolean;
  scheme: string;
  minPluginVersion: string;
}) {
  return (
    <Alert id={id} role={auto ? 'alert' : 'region'} aria-label="Troubleshooting">
      <CircleHelpIcon aria-hidden />
      <AlertTitle>
        {auto ? 'Nothing has arrived from RuneLite yet' : 'If pairing doesn’t work'}
      </AlertTitle>
      <AlertDescription>
        <ul className="mt-1 flex list-disc flex-col gap-1.5 pl-4">
          <li>
            Check that the Endpoint URL starts with <span className="font-mono">{scheme}</span>. A
            URL without it fails silently in the plugin: no message appears and Submit stays greyed
            out until you edit a field.
          </li>
          <li>Check the code: exactly the 5 digits above, and not expired.</li>
          <li>
            Make sure HA Exporter is version {minPluginVersion} or newer: restarting RuneLite
            updates it.
          </li>
          <li>
            Check that RuneLite can reach the hub: open the URL in a browser on the same computer.
          </li>
        </ul>
      </AlertDescription>
    </Alert>
  );
}
