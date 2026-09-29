'use client';
/**
 * The pairing wizard (handoff §6.3, "the whole point: make it dead simple"; goal: onboarded in under
 * two minutes, handoff §2). Four steps — Install, Pair, First data, Done — driven by wizardReducer
 * (wizard-model.ts), which holds every rule and is unit-tested.
 *
 * - Step 2 creates a pairing code when it is entered and on Regenerate (POST /api/app/pairing-codes).
 * - Progress arrives on the page's one live stream (LiveProvider, handoff §11): 'pairing' messages
 *   for this wizard's codes and the 'device' message with the first data. While the stream is down
 *   the wizard polls GET /api/app/pairing-codes/[id] every 3 s instead, and every 15 s while it is
 *   open as a safety net (a message missed during a reconnect is not replayed). It polls every code
 *   it may still be paired with (codesToPoll), not only the one shown.
 * - Focus moves to the new step's heading on every step change.
 *
 * Reachable any time as "Add device" (dashboard, devices page).
 */
import { useRouter } from 'next/navigation';
import { useEffect, useEffectEvent, useReducer, useRef, useState } from 'react';
import { useLiveStatus, useLiveSubscription } from '@/components/live/live-provider';
import { Card, CardContent } from '@/components/ui/card';
import { DoneStep } from './done-step';
import { FirstDataStep } from './first-data-step';
import { InstallStep } from './install-step';
import { PairStep } from './pair-step';
import { useSecondClock } from './use-second-clock';
import {
  INITIAL_WIZARD_STATE,
  POLL_INTERVAL_CONNECTED_MS,
  POLL_INTERVAL_MS,
  apiErrorMessage,
  asDeviceMessage,
  asPairingMessage,
  codeMsLeft,
  codesToPoll,
  isCodeExpired,
  parseCreatedCode,
  parsePolledStatus,
  showOutdatedAlert,
  showTroubleshooting,
  submitWaitSecondsLeft,
  wizardReducer,
} from './wizard-model';
import { WizardProgress } from './wizard-progress';

export interface OnboardingWizardProps {
  /** PAIRING_CODE_TTL_SECONDS: how long a new code is valid. */
  ttlSeconds: number;
  /** MIN_PLUGIN_VERSION, e.g. "1.5". */
  minPluginVersion: string;
}

export function OnboardingWizard({ ttlSeconds, minPluginVersion }: OnboardingWizardProps) {
  const router = useRouter();
  const { connected } = useLiveStatus();
  const [state, dispatch] = useReducer(wizardReducer, INITIAL_WIZARD_STATE);
  const [label, setLabel] = useState('');
  const requestSeq = useRef(0);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const shownStep = useRef(state.step);

  // The clock runs while a code may still be paired: its countdown, and which codes to poll (also
  // after going back to step 1).
  const pairing = state.step <= 2 && state.codeIds.length > 0 && state.deviceId === null;
  const now = useSecondClock(pairing);
  const expired = now !== null ? isCodeExpired(state, now) : state.expiredByServer;

  useLiveSubscription('pairing', (data) => {
    const message = asPairingMessage(data);
    if (message) dispatch({ type: 'pairing', message, at: Date.now() });
  });
  useLiveSubscription('device', (data) => {
    const message = asDeviceMessage(data);
    if (message) dispatch({ type: 'device', message });
  });

  // Keyboard and screen-reader users land on the new step, not on a button that went away.
  useEffect(() => {
    if (shownStep.current === state.step) return;
    shownStep.current = state.step;
    headingRef.current?.focus();
  }, [state.step]);

  const poll = useEffectEvent(async (codeId: string, signal: AbortSignal): Promise<void> => {
    try {
      const res = await fetch(`/api/app/pairing-codes/${encodeURIComponent(codeId)}`, {
        credentials: 'same-origin',
        cache: 'no-store',
        signal,
      });
      if (res.status === 401) {
        // Signed out elsewhere: the layout's requireUser() sends the browser to /login.
        router.refresh();
        return;
      }
      if (!res.ok) return;
      const status = parsePolledStatus(await res.json());
      if (status) dispatch({ type: 'polled', status, at: Date.now() });
    } catch {
      // Offline or aborted: the next tick tries again.
    }
  });

  // The codes that may still be paired, or the consumed one while waiting for the first data. A
  // string key, so the interval restarts only when the set changes (not on every clock tick).
  const pollKey = codesToPoll(state, now).join(' ');
  const pollMs = connected ? POLL_INTERVAL_CONNECTED_MS : POLL_INTERVAL_MS;

  useEffect(() => {
    if (pollKey === '') return;
    const codeIds = pollKey.split(' ');
    const controller = new AbortController();
    let busy = false;
    const timer = setInterval(() => {
      if (busy) return;
      busy = true;
      void Promise.all(codeIds.map((id) => poll(id, controller.signal))).finally(() => {
        busy = false;
      });
    }, pollMs);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [pollKey, pollMs]);

  async function createCode(): Promise<void> {
    const seq = ++requestSeq.current;
    dispatch({ type: 'codeRequested' });
    try {
      const res = await fetch('/api/app/pairing-codes', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label: label.trim() || null }),
      });
      const receivedAt = Date.now();
      const body: unknown = await res.json().catch(() => null);
      if (seq !== requestSeq.current) return; // a newer request (Regenerate) wins
      if (res.status === 401) {
        dispatch({ type: 'codeFailed', message: 'Your session has ended. Sign in again.' });
        router.refresh();
        return;
      }
      const code = res.ok ? parseCreatedCode(body, receivedAt, ttlSeconds) : null;
      if (code) {
        dispatch({ type: 'codeCreated', code });
      } else {
        dispatch({
          type: 'codeFailed',
          message: apiErrorMessage(body, "The hub couldn't create a code. Try again in a moment."),
        });
      }
    } catch {
      if (seq === requestSeq.current) {
        dispatch({
          type: 'codeFailed',
          message: "Couldn't reach the hub. Check your connection and try again.",
        });
      }
    }
  }

  function startPairing(): void {
    if (state.deviceId !== null) {
      // Paired while the user was back on step 1.
      dispatch({ type: 'goto', step: 3 });
      return;
    }
    dispatch({ type: 'goto', step: 2 });
    void createCode();
  }

  function restart(): void {
    requestSeq.current += 1;
    setLabel('');
    dispatch({ type: 'reset' });
  }

  const outdated = showOutdatedAlert(state) ? state.outdated : null;

  return (
    <div className="flex flex-col gap-6">
      <WizardProgress current={state.step} />
      <Card>
        <CardContent>
          {state.step === 1 && (
            <InstallStep
              headingRef={headingRef}
              minPluginVersion={minPluginVersion}
              label={label}
              onLabelChange={setLabel}
              onNext={startPairing}
            />
          )}
          {state.step === 2 && (
            <PairStep
              headingRef={headingRef}
              code={state.code}
              codeRequest={state.codeRequest}
              codeError={state.codeError}
              msLeft={now === null ? null : codeMsLeft(state, now)}
              expired={expired}
              connected={connected}
              outdated={outdated}
              waitSecondsLeft={now === null ? null : submitWaitSecondsLeft(state, now)}
              troubleshooting={now !== null && showTroubleshooting(state, now)}
              minPluginVersion={minPluginVersion}
              onRegenerate={() => void createCode()}
              onSubmitted={() => dispatch({ type: 'submitted', at: Date.now() })}
              onBack={() => dispatch({ type: 'goto', step: 1 })}
            />
          )}
          {state.step === 3 && (
            <FirstDataStep
              headingRef={headingRef}
              firstData={state.firstData}
              connected={connected}
              onContinue={() => dispatch({ type: 'goto', step: 4 })}
            />
          )}
          {state.step === 4 && (
            <DoneStep headingRef={headingRef} firstData={state.firstData} onRestart={restart} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
