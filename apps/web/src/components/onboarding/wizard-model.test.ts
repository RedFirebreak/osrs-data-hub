import type { DeviceMessage } from '@hub/server';
import { describe, expect, it } from 'vitest';
import {
  INITIAL_WIZARD_STATE,
  SUBMIT_TIMEOUT_MS,
  apiErrorMessage,
  asDeviceFirstData,
  asDeviceMessage,
  asPairingMessage,
  codeMsLeft,
  codesToPoll,
  describeCountdown,
  describeRole,
  formatCountdown,
  isCodeExpired,
  parseCreatedCode,
  parsePolledStatus,
  schemeOf,
  showOutdatedAlert,
  showTroubleshooting,
  spellDigits,
  submitWaitSecondsLeft,
  wizardReducer,
  type PolledCodeStatus,
  type WizardAction,
  type WizardCode,
  type WizardState,
} from './wizard-model';

const T0 = 1_800_000_000_000;

function code(id: string, expiresAtMs = T0 + 300_000): WizardCode {
  return {
    id,
    code: '04817',
    baseUrl: 'https://hub.example.com',
    expiresAtMs,
    lifetimeMs: 300_000,
  };
}

function run(...actions: WizardAction[]): WizardState {
  return actions.reduce(wizardReducer, INITIAL_WIZARD_STATE);
}

/** A wizard on step 2 showing code `c1`. */
function onStep2(...more: WizardAction[]): WizardState {
  return run(
    { type: 'goto', step: 2 },
    { type: 'codeRequested' },
    { type: 'codeCreated', code: code('c1') },
    ...more,
  );
}

const deviceMessage: DeviceMessage = {
  deviceId: 'd1',
  account: { publicId: 'AbCdEf123456', name: 'Zezima', accountType: 1 },
  role: 'owner',
  ownerName: 'Alice',
};

function polled(overrides: Partial<PolledCodeStatus> = {}): PolledCodeStatus {
  return {
    codeId: 'c1',
    status: 'active',
    deviceId: null,
    outdatedAttemptAt: null,
    outdatedVersion: null,
    device: null,
    ...overrides,
  };
}

describe('formatCountdown', () => {
  it('shows mm:ss, rounding seconds up and never going below zero', () => {
    expect(formatCountdown(300_000)).toBe('05:00');
    expect(formatCountdown(299_001)).toBe('05:00');
    expect(formatCountdown(61_000)).toBe('01:01');
    expect(formatCountdown(59_999)).toBe('01:00');
    expect(formatCountdown(1)).toBe('00:01');
    expect(formatCountdown(0)).toBe('00:00');
    expect(formatCountdown(-5_000)).toBe('00:00');
    expect(formatCountdown(Number.NaN)).toBe('00:00');
    expect(formatCountdown(6_000_000)).toBe('100:00');
  });

  it('describes the time left in words for screen readers', () => {
    expect(describeCountdown(252_000)).toBe('4 minutes 12 seconds');
    expect(describeCountdown(60_000)).toBe('1 minute');
    expect(describeCountdown(1_000)).toBe('1 second');
    expect(describeCountdown(0)).toBe('0 seconds');
  });
});

describe('small helpers', () => {
  it('spells the code digit by digit, keeping leading zeros (PLUGIN-6)', () => {
    expect(spellDigits('04817')).toBe('0 4 8 1 7');
  });

  it("names the base URL's scheme for the copy note", () => {
    expect(schemeOf('https://hub.example.com')).toBe('https://');
    expect(schemeOf('HTTP://127.0.0.1:3100')).toBe('http://');
    expect(schemeOf('hub.example.com')).toBe('https://');
  });

  it('describes the role on the first account', () => {
    expect(describeRole({ role: 'owner', ownerName: 'Alice' })).toBe("You're the owner");
    expect(describeRole({ role: 'contributor', ownerName: 'Bob' })).toBe(
      'Linked as contributor; owner is Bob',
    );
    expect(describeRole({ role: 'contributor', ownerName: null })).toBe('Linked as contributor');
  });

  it('reads error messages from API error bodies', () => {
    expect(apiErrorMessage({ error: { code: 'x', message: 'Nope.' } }, 'fallback')).toBe('Nope.');
    expect(apiErrorMessage(null, 'fallback')).toBe('fallback');
    expect(apiErrorMessage({ error: 'x' }, 'fallback')).toBe('fallback');
  });
});

describe('parsing API bodies', () => {
  it('turns a created code into a WizardCode on the browser clock', () => {
    const body = {
      id: 'c1',
      code: '04817',
      expiresAt: '1999-01-01T00:05:00.000Z', // a skewed server/PC clock doesn't matter
      baseUrl: 'https://hub.example.com',
    };
    expect(parseCreatedCode(body, T0, 300)).toEqual({
      id: 'c1',
      code: '04817',
      baseUrl: 'https://hub.example.com',
      expiresAtMs: T0 + 300_000,
      lifetimeMs: 300_000,
    });
    for (const bad of [
      null,
      { ...body, code: 4817 },
      { ...body, code: '4817' },
      { ...body, code: '٠٤٨١٧' },
      { ...body, baseUrl: undefined },
      { ...body, expiresAt: 'soon' },
    ]) {
      expect(parseCreatedCode(bad, T0, 300)).toBeNull();
    }
  });

  it('parses a polled status with and without first data', () => {
    const device = {
      account: { publicId: 'AbCdEf123456', name: 'Zezima', accountType: null },
      role: 'contributor',
      ownerName: 'Bob',
    };
    expect(
      parsePolledStatus({
        code: {
          id: 'c1',
          code: '04817',
          status: 'consumed',
          expiresAt: '2026-09-29T10:00:00.000Z',
          deviceId: 'd1',
          outdatedAttemptAt: null,
          outdatedVersion: null,
        },
        device,
      }),
    ).toEqual({
      codeId: 'c1',
      status: 'consumed',
      deviceId: 'd1',
      outdatedAttemptAt: null,
      outdatedVersion: null,
      device,
    });
    expect(parsePolledStatus({ code: { id: 'c1', status: 'weird' } })).toBeNull();
    expect(parsePolledStatus({})).toBeNull();
    expect(asDeviceFirstData({ ...device, role: 'admin' })).toBeNull();
    expect(asDeviceFirstData({ ...device, account: { name: 'x' } })).toBeNull();
  });

  it('checks live pairing and device messages', () => {
    expect(asPairingMessage({ kind: 'consumed', codeId: 'c1', deviceId: 'd1' })).toEqual({
      kind: 'consumed',
      codeId: 'c1',
      deviceId: 'd1',
    });
    expect(asPairingMessage({ kind: 'outdated_plugin', codeId: 'c1', version: null })).toEqual({
      kind: 'outdated_plugin',
      codeId: 'c1',
      version: null,
    });
    expect(asPairingMessage({ kind: 'outdated_plugin', codeId: 'c1', version: '1.4' })).toEqual({
      kind: 'outdated_plugin',
      codeId: 'c1',
      version: '1.4',
    });
    for (const bad of [
      null,
      { kind: 'consumed', codeId: 'c1' },
      { kind: 'other', codeId: 'c1' },
      { kind: 'outdated_plugin' },
    ]) {
      expect(asPairingMessage(bad)).toBeNull();
    }
    expect(asDeviceMessage(deviceMessage)).toEqual(deviceMessage);
    expect(asDeviceMessage({ ...deviceMessage, deviceId: 5 })).toBeNull();
    expect(asDeviceMessage({ deviceId: 'd1' })).toBeNull();
  });
});

describe('wizardReducer', () => {
  it('creates a code on step 2 and remembers every code id', () => {
    const s = onStep2({ type: 'codeRequested' }, { type: 'codeCreated', code: code('c2') });
    expect(s.step).toBe(2);
    expect(s.code?.id).toBe('c2');
    expect(s.codeIds).toEqual(['c1', 'c2']);
    expect(s.codeRequest).toBe('idle');
  });

  it('records a failed code request and clears it on the next attempt', () => {
    const failed = run({ type: 'codeRequested' }, { type: 'codeFailed', message: 'Busy.' });
    expect(failed).toMatchObject({ codeRequest: 'failed', codeError: 'Busy.' });
    expect(wizardReducer(failed, { type: 'codeRequested' })).toMatchObject({
      codeRequest: 'loading',
      codeError: null,
    });
  });

  it('moves on to step 3 when the code is consumed (live message)', () => {
    const s = onStep2({
      type: 'pairing',
      message: { kind: 'consumed', codeId: 'c1', deviceId: 'd1' },
      at: T0,
    });
    expect(s).toMatchObject({ step: 3, deviceId: 'd1', pairedCodeId: 'c1' });
  });

  it('accepts the consumption of an older code of this wizard, and ignores foreign codes', () => {
    const regenerated = onStep2({ type: 'codeCreated', code: code('c2') });
    const foreign = wizardReducer(regenerated, {
      type: 'pairing',
      message: { kind: 'consumed', codeId: 'other', deviceId: 'dx' },
      at: T0,
    });
    expect(foreign).toBe(regenerated);
    const older = wizardReducer(regenerated, {
      type: 'pairing',
      message: { kind: 'consumed', codeId: 'c1', deviceId: 'd1' },
      at: T0,
    });
    expect(older).toMatchObject({ step: 3, deviceId: 'd1', pairedCodeId: 'c1' });
  });

  it('moves on from step 1 too when pairing happens after the user went back', () => {
    const s = onStep2(
      { type: 'goto', step: 1 },
      { type: 'pairing', message: { kind: 'consumed', codeId: 'c1', deviceId: 'd1' }, at: T0 },
    );
    expect(s.step).toBe(3);
  });

  it('keeps the first pairing: a second consumed message changes nothing', () => {
    const once = onStep2({
      type: 'pairing',
      message: { kind: 'consumed', codeId: 'c1', deviceId: 'd1' },
      at: T0,
    });
    const twice = wizardReducer(once, {
      type: 'pairing',
      message: { kind: 'consumed', codeId: 'c1', deviceId: 'd2' },
      at: T0,
    });
    expect(twice).toBe(once);
  });

  it('shows the first data from a device message for its own device only', () => {
    const paired = onStep2({
      type: 'pairing',
      message: { kind: 'consumed', codeId: 'c1', deviceId: 'd1' },
      at: T0,
    });
    const other = wizardReducer(paired, {
      type: 'device',
      message: { ...deviceMessage, deviceId: 'd9' },
    });
    expect(other.firstData).toBeNull();
    const mine = wizardReducer(other, { type: 'device', message: deviceMessage });
    expect(mine.firstData).toEqual({
      account: deviceMessage.account,
      role: 'owner',
      ownerName: 'Alice',
    });
  });

  it('keeps a device message that arrived before the pairing message', () => {
    const s = onStep2(
      { type: 'device', message: deviceMessage },
      { type: 'pairing', message: { kind: 'consumed', codeId: 'c1', deviceId: 'd1' }, at: T0 },
    );
    expect(s.firstData?.account.name).toBe('Zezima');
    expect(s.pendingDevices).toEqual({});
  });

  it('pairs and shows the first data from a poll (the live stream was down)', () => {
    const s = onStep2({
      type: 'polled',
      status: polled({
        status: 'consumed',
        deviceId: 'd1',
        device: { account: deviceMessage.account, role: 'contributor', ownerName: 'Bob' },
      }),
      at: T0,
    });
    expect(s).toMatchObject({ step: 3, deviceId: 'd1' });
    expect(s.firstData?.role).toBe('contributor');
  });

  it('ignores polls for codes it did not create', () => {
    const s = onStep2();
    expect(
      wizardReducer(s, {
        type: 'polled',
        status: polled({ codeId: 'x', status: 'consumed', deviceId: 'd' }),
        at: T0,
      }),
    ).toBe(s);
  });

  it('marks the current code expired when the server says so', () => {
    const s = onStep2({ type: 'polled', status: polled({ status: 'expired' }), at: T0 });
    expect(s.expiredByServer).toBe(true);
    expect(isCodeExpired(s, T0)).toBe(true);
    const renewed = wizardReducer(s, { type: 'codeCreated', code: code('c2') });
    expect(renewed.expiredByServer).toBe(false);
    expect(isCodeExpired(renewed, T0)).toBe(false);
  });

  it('resets to the first step', () => {
    expect(onStep2({ type: 'reset' })).toBe(INITIAL_WIZARD_STATE);
  });
});

describe('codesToPoll', () => {
  it('polls every code of this wizard the hub may still accept, the shown one first', () => {
    const s = onStep2(
      { type: 'codeCreated', code: code('c2', T0 + 360_000) },
      { type: 'codeCreated', code: code('c3', T0 + 420_000) },
    );
    expect(codesToPoll(s, T0)).toEqual(['c3', 'c2', 'c1']);
    // c1's lifetime is over; the hub has expired it.
    expect(codesToPoll(s, T0 + 300_000)).toEqual(['c3', 'c2']);
    // A fourth code retires the oldest on the hub (at most 3 active).
    const four = wizardReducer(s, { type: 'codeCreated', code: code('c4', T0 + 480_000) });
    expect(codesToPoll(four, T0)).toEqual(['c4', 'c3', 'c2']);
    // Still polled after going back to step 1 (pairing there moves on to step 3).
    expect(codesToPoll(wizardReducer(s, { type: 'goto', step: 1 }), T0)).toEqual([
      'c3',
      'c2',
      'c1',
    ]);
    // Nothing before the browser clock runs.
    expect(codesToPoll(s, null)).toEqual([]);
  });

  it('leaves out the shown code once the hub said it expired', () => {
    const s = onStep2(
      { type: 'codeCreated', code: code('c2', T0 + 360_000) },
      { type: 'polled', status: polled({ codeId: 'c2', status: 'expired' }), at: T0 },
    );
    expect(codesToPoll(s, T0)).toEqual(['c1']);
  });

  it('polls the consumed code on step 3 until the first data arrived', () => {
    const paired = onStep2(
      { type: 'codeCreated', code: code('c2') },
      { type: 'pairing', message: { kind: 'consumed', codeId: 'c1', deviceId: 'd1' }, at: T0 },
    );
    expect(codesToPoll(paired, T0)).toEqual(['c1']);
    expect(codesToPoll(paired, null)).toEqual(['c1']);
    const withData = wizardReducer(paired, { type: 'device', message: deviceMessage });
    expect(codesToPoll(withData, T0)).toEqual([]);
    expect(codesToPoll(wizardReducer(paired, { type: 'goto', step: 4 }), T0)).toEqual([]);
    expect(codesToPoll(INITIAL_WIZARD_STATE, T0)).toEqual([]);
  });
});

describe('countdown and expiry', () => {
  it('counts down on the browser clock and expires at zero', () => {
    const s = onStep2();
    expect(codeMsLeft(s, T0)).toBe(300_000);
    expect(isCodeExpired(s, T0 + 299_999)).toBe(false);
    expect(isCodeExpired(s, T0 + 300_000)).toBe(true);
    expect(codeMsLeft(s, T0 + 400_000)).toBe(0);
    // A clock value from before the code arrived never shows more than its lifetime.
    expect(codeMsLeft(s, T0 - 60_000)).toBe(300_000);
  });

  it('never calls a code expired once pairing succeeded', () => {
    const s = onStep2({
      type: 'pairing',
      message: { kind: 'consumed', codeId: 'c1', deviceId: 'd1' },
      at: T0,
    });
    expect(isCodeExpired(s, T0 + 999_999)).toBe(false);
  });
});

describe('outdated plugin and troubleshooting', () => {
  const outdated: WizardAction = {
    type: 'pairing',
    message: { kind: 'outdated_plugin', codeId: 'c1', version: '1.4' },
    at: T0 + 5_000,
  };

  it('shows the outdated alert until the user presses Submit again', () => {
    const s = onStep2(outdated);
    expect(showOutdatedAlert(s)).toBe(true);
    expect(s.outdated?.version).toBe('1.4');
    const resubmitted = wizardReducer(s, { type: 'submitted', at: T0 + 10_000 });
    expect(showOutdatedAlert(resubmitted)).toBe(false);
    // Another outdated attempt after that shows it again.
    const again = wizardReducer(resubmitted, { ...outdated, at: T0 + 20_000 });
    expect(showOutdatedAlert(again)).toBe(true);
  });

  it('shows a polled outdated attempt once, not again after Submit for the same attempt', () => {
    const attempt = polled({
      outdatedAttemptAt: '2026-09-29T10:00:00.000Z',
      outdatedVersion: '1.3',
    });
    const s = onStep2({ type: 'polled', status: attempt, at: T0 });
    expect(showOutdatedAlert(s)).toBe(true);
    const resubmitted = wizardReducer(s, { type: 'submitted', at: T0 + 1_000 });
    const samePoll = wizardReducer(resubmitted, {
      type: 'polled',
      status: attempt,
      at: T0 + 4_000,
    });
    expect(showOutdatedAlert(samePoll)).toBe(false);
    const newAttempt = wizardReducer(samePoll, {
      type: 'polled',
      status: { ...attempt, outdatedAttemptAt: '2026-09-29T10:01:00.000Z' },
      at: T0 + 7_000,
    });
    expect(showOutdatedAlert(newAttempt)).toBe(true);
  });

  it('takes the first poll after a live outdated message as the same attempt, not a new one', () => {
    // Live message (attempt A), the user restarts RuneLite and presses "I pressed Submit again";
    // the next poll reports attempt A's time for the first time: that is no new attempt.
    const attemptA = polled({
      outdatedAttemptAt: '2026-09-29T10:00:00.000Z',
      outdatedVersion: '1.4',
    });
    const resubmitted = onStep2(outdated, { type: 'submitted', at: T0 + 10_000 });
    expect(showOutdatedAlert(resubmitted)).toBe(false);
    const polledA = wizardReducer(resubmitted, {
      type: 'polled',
      status: attemptA,
      at: T0 + 12_000,
    });
    expect(showOutdatedAlert(polledA)).toBe(false);
    expect(showTroubleshooting(polledA, T0 + 10_000 + SUBMIT_TIMEOUT_MS)).toBe(true);

    // Another live message (attempt B) after the poll knew A, Submit again, then a poll reports B.
    const liveB = wizardReducer(polledA, { ...outdated, at: T0 + 20_000 });
    expect(showOutdatedAlert(liveB)).toBe(true);
    const again = wizardReducer(liveB, { type: 'submitted', at: T0 + 25_000 });
    const polledB = wizardReducer(again, {
      type: 'polled',
      status: { ...attemptA, outdatedAttemptAt: '2026-09-29T10:00:20.000Z' },
      at: T0 + 27_000,
    });
    expect(showOutdatedAlert(polledB)).toBe(false);

    // A poll-only attempt after that is new.
    const polledC = wizardReducer(polledB, {
      type: 'polled',
      status: { ...attemptA, outdatedAttemptAt: '2026-09-29T10:01:00.000Z' },
      at: T0 + 40_000,
    });
    expect(showOutdatedAlert(polledC)).toBe(true);
  });

  it('shows troubleshooting 60 s after "I pressed Submit" when nothing arrived', () => {
    const s = onStep2({ type: 'submitted', at: T0 });
    expect(submitWaitSecondsLeft(s, T0)).toBe(60);
    expect(submitWaitSecondsLeft(s, T0 - 900)).toBe(60); // the clock lags the click
    expect(submitWaitSecondsLeft(s, T0 + 59_001)).toBe(1);
    expect(showTroubleshooting(s, T0 + SUBMIT_TIMEOUT_MS - 1)).toBe(false);
    expect(showTroubleshooting(s, T0 + SUBMIT_TIMEOUT_MS)).toBe(true);
    expect(submitWaitSecondsLeft(s, T0 + SUBMIT_TIMEOUT_MS)).toBeNull();
    expect(showTroubleshooting(onStep2(), T0 + 999_999)).toBe(false);
  });

  it('shows no troubleshooting when the plugin answered (outdated) or pairing succeeded', () => {
    const answered = onStep2({ type: 'submitted', at: T0 }, { ...outdated, at: T0 + 30_000 });
    expect(showTroubleshooting(answered, T0 + 120_000)).toBe(false);
    const paired = onStep2(
      { type: 'submitted', at: T0 },
      { type: 'pairing', message: { kind: 'consumed', codeId: 'c1', deviceId: 'd1' }, at: T0 },
    );
    expect(showTroubleshooting(paired, T0 + 120_000)).toBe(false);
  });
});
