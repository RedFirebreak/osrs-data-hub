/**
 * The pairing wizard's state machine and helpers (handoff §6.3), kept free of React and browser APIs
 * so every rule is unit-tested in the node test project (wizard-model.test.ts).
 *
 * Steps: 1 Install → 2 Pair → 3 First data → 4 Done. Step 2 holds a pairing code created through
 * POST /api/app/pairing-codes; progress arrives as live 'pairing' / 'device' messages
 * (LiveProvider, handoff §11) or, while the live stream is down, from polling
 * GET /api/app/pairing-codes/[id]. Both feed the same reducer, so whichever arrives first wins and
 * the other is a no-op.
 *
 * Time is always passed in (`at`, `now`): the reducer stays pure, and the countdown uses the
 * browser's clock only relative to when the code arrived, so a skewed PC clock can't expire a code
 * early.
 *
 * Only `import type` from @hub/server: this module is bundled for the browser (NEXT-12).
 */
import type { DeviceFirstData, DeviceMessage, PairingMessage } from '@hub/server';

export type WizardStep = 1 | 2 | 3 | 4;

export const WIZARD_STEPS: readonly { step: WizardStep; label: string }[] = [
  { step: 1, label: 'Install' },
  { step: 2, label: 'Pair' },
  { step: 3, label: 'First data' },
  { step: 4, label: 'Done' },
];

/** How long after "I pressed Submit" the troubleshooting tips appear (handoff §6.3). */
export const SUBMIT_TIMEOUT_MS = 60_000;
/** Polling interval of GET /api/app/pairing-codes/[id] while the live stream is down. */
export const POLL_INTERVAL_MS = 3_000;
/** Safety polling interval while the stream is open (a message lost in a reconnect isn't replayed). */
export const POLL_INTERVAL_CONNECTED_MS = 15_000;
/** Longest device label kept by the hub (DEVICE_LABEL_MAX in @hub/server). */
export const DEVICE_LABEL_MAX_LENGTH = 64;
/** Active codes the hub keeps per user (MAX_ACTIVE_PAIRING_CODES in @hub/server); older ones retire. */
export const MAX_ACTIVE_CODES = 3;

/** A pairing code as the wizard keeps it. */
export interface WizardCode {
  id: string;
  /** 5 ASCII digits, always a string (leading zeros matter, PLUGIN-6). */
  code: string;
  /** APP_URL's origin, e.g. https://hub.example.com — pasted into the plugin as is. */
  baseUrl: string;
  /** Expiry on the browser's clock (ms): when it arrived + the code's lifetime. */
  expiresAtMs: number;
  /** The code's lifetime (ms); the countdown never shows more. */
  lifetimeMs: number;
}

export interface OutdatedAttempt {
  /** The plugin version the hub saw, when known. */
  version: string | null;
  /** When the wizard learned about it (browser clock, ms). */
  receivedAt: number;
}

export interface WizardState {
  step: WizardStep;
  /** The newest code (shown on step 2). */
  code: WizardCode | null;
  codeRequest: 'idle' | 'loading' | 'failed';
  codeError: string | null;
  /** Every code this wizard created: a message for an older, still active one counts too. */
  codeIds: readonly string[];
  /** Expiry of each of those codes on the browser's clock (ms), by id (see codesToPoll). */
  codeExpiresAtMs: Readonly<Record<string, number>>;
  /** The code that was consumed (polled on step 3 for the first data). */
  pairedCodeId: string | null;
  /** The device pairing created; null until paired. */
  deviceId: string | null;
  /** The last attempt from a plugin below the minimum version, if any. */
  outdated: OutdatedAttempt | null;
  /** `outdatedAttemptAt` of the last attempt a poll reported (to tell a new attempt from an old). */
  polledOutdatedAt: string | null;
  /**
   * A live 'outdated_plugin' message announced an attempt that no poll has reported yet. Live
   * messages carry no attempt time, so the next new `outdatedAttemptAt` a poll reports is that same
   * attempt, not another one (else it would re-show the alert after "I pressed Submit again").
   */
  liveOutdatedUnpolled: boolean;
  /** When the user said they pressed Submit in the plugin (browser clock, ms). */
  submittedAt: number | null;
  /** The server said the current code expired (the browser clock may disagree). */
  expiredByServer: boolean;
  /** The first account the device reported. */
  firstData: DeviceFirstData | null;
  /** 'device' messages that arrived before the wizard knew its device id, by device id. */
  pendingDevices: Readonly<Record<string, DeviceFirstData>>;
}

export const INITIAL_WIZARD_STATE: WizardState = {
  step: 1,
  code: null,
  codeRequest: 'idle',
  codeError: null,
  codeIds: [],
  codeExpiresAtMs: {},
  pairedCodeId: null,
  deviceId: null,
  outdated: null,
  polledOutdatedAt: null,
  liveOutdatedUnpolled: false,
  submittedAt: null,
  expiredByServer: false,
  firstData: null,
  pendingDevices: {},
};

/** The state of a code as GET /api/app/pairing-codes/[id] reports it (parsed). */
export interface PolledCodeStatus {
  codeId: string;
  status: 'active' | 'consumed' | 'expired';
  deviceId: string | null;
  outdatedAttemptAt: string | null;
  outdatedVersion: string | null;
  device: DeviceFirstData | null;
}

export type WizardAction =
  | { type: 'goto'; step: WizardStep }
  | { type: 'reset' }
  | { type: 'codeRequested' }
  | { type: 'codeCreated'; code: WizardCode }
  | { type: 'codeFailed'; message: string }
  | { type: 'submitted'; at: number }
  | { type: 'pairing'; message: PairingMessage; at: number }
  | { type: 'device'; message: DeviceMessage }
  | { type: 'polled'; status: PolledCodeStatus; at: number };

function firstDataOf(message: DeviceMessage): DeviceFirstData {
  return { account: message.account, role: message.role, ownerName: message.ownerName };
}

/**
 * Pairing succeeded with `codeId` → `deviceId`: on to step 3 (also from step 1, if the user went back
 * meanwhile), with any first data that already arrived. A second pairing is ignored.
 */
function paired(state: WizardState, codeId: string, deviceId: string): WizardState {
  if (state.deviceId !== null) return state;
  const { [deviceId]: early, ...pendingDevices } = state.pendingDevices;
  return {
    ...state,
    step: state.step < 3 ? 3 : state.step,
    pairedCodeId: codeId,
    deviceId,
    outdated: null,
    submittedAt: null,
    firstData: state.firstData ?? early ?? null,
    pendingDevices,
  };
}

export function wizardReducer(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case 'goto':
      return { ...state, step: action.step };
    case 'reset':
      return INITIAL_WIZARD_STATE;
    case 'codeRequested':
      return { ...state, codeRequest: 'loading', codeError: null };
    case 'codeCreated':
      return {
        ...state,
        code: action.code,
        codeRequest: 'idle',
        codeError: null,
        codeIds: state.codeIds.includes(action.code.id)
          ? state.codeIds
          : [...state.codeIds, action.code.id],
        codeExpiresAtMs: { ...state.codeExpiresAtMs, [action.code.id]: action.code.expiresAtMs },
        outdated: null,
        polledOutdatedAt: null,
        liveOutdatedUnpolled: false,
        submittedAt: null,
        expiredByServer: false,
      };
    case 'codeFailed':
      return { ...state, codeRequest: 'failed', codeError: action.message };
    case 'submitted':
      return { ...state, submittedAt: action.at };
    case 'pairing': {
      const { message } = action;
      if (!state.codeIds.includes(message.codeId) || state.deviceId !== null) return state;
      if (message.kind === 'consumed') return paired(state, message.codeId, message.deviceId);
      return {
        ...state,
        outdated: { version: message.version, receivedAt: action.at },
        liveOutdatedUnpolled: message.codeId === state.code?.id || state.liveOutdatedUnpolled,
      };
    }
    case 'device': {
      const { message } = action;
      if (state.deviceId === null) {
        return {
          ...state,
          pendingDevices: { ...state.pendingDevices, [message.deviceId]: firstDataOf(message) },
        };
      }
      if (message.deviceId !== state.deviceId || state.firstData !== null) return state;
      return { ...state, firstData: firstDataOf(message) };
    }
    case 'polled': {
      const { status } = action;
      if (!state.codeIds.includes(status.codeId)) return state;
      let next = state;
      if (status.status === 'consumed' && status.deviceId !== null) {
        next = paired(next, status.codeId, status.deviceId);
        if (next.firstData === null && status.device && status.deviceId === next.deviceId) {
          next = { ...next, firstData: status.device };
        }
        return next;
      }
      if (next.deviceId !== null) return next;
      const isCurrent = next.code?.id === status.codeId;
      if (isCurrent && status.status === 'expired' && !next.expiredByServer) {
        next = { ...next, expiredByServer: true };
      }
      if (
        isCurrent &&
        status.outdatedAttemptAt !== null &&
        status.outdatedAttemptAt !== next.polledOutdatedAt
      ) {
        next = next.liveOutdatedUnpolled
          ? // The attempt a live message already announced: learn its time, keep the alert as is.
            { ...next, polledOutdatedAt: status.outdatedAttemptAt, liveOutdatedUnpolled: false }
          : {
              ...next,
              polledOutdatedAt: status.outdatedAttemptAt,
              outdated: { version: status.outdatedVersion, receivedAt: action.at },
            };
      }
      return next;
    }
  }
}

/**
 * Milliseconds left on the current code (0 when expired or there is none), never more than its
 * lifetime: the one-second clock can lag behind the moment the code arrived by up to a tick.
 */
export function codeMsLeft(state: WizardState, now: number): number {
  if (!state.code || state.expiredByServer) return 0;
  return Math.min(state.code.lifetimeMs, Math.max(0, state.code.expiresAtMs - now));
}

/** The current code can no longer be used (and pairing hasn't happened). */
export function isCodeExpired(state: WizardState, now: number): boolean {
  return state.code !== null && state.deviceId === null && codeMsLeft(state, now) === 0;
}

/**
 * The codes to poll with GET /api/app/pairing-codes/[id] at `now` (browser clock; null before it
 * runs). Before pairing (steps 1 and 2): every code of this wizard the hub may still accept — the
 * newest MAX_ACTIVE_CODES within their lifetime, the shown one first and not once the hub said it
 * expired — because the player may have typed an older one (Regenerate, or Back and Next) and the
 * reducer accepts any of them; polling only the shown one would leave the wizard waiting forever
 * when the live message is lost. After pairing: the consumed code on step 3 until the first data
 * arrived. Empty otherwise.
 */
export function codesToPoll(state: WizardState, now: number | null): string[] {
  if (state.deviceId !== null) {
    return state.step === 3 && state.firstData === null && state.pairedCodeId !== null
      ? [state.pairedCodeId]
      : [];
  }
  if (state.step > 2 || now === null) return [];
  return state.codeIds
    .slice(-MAX_ACTIVE_CODES)
    .reverse()
    .filter(
      (id) =>
        !(id === state.code?.id && state.expiredByServer) && (state.codeExpiresAtMs[id] ?? 0) > now,
    );
}

/** Show the outdated-plugin alert: an attempt newer than the user's last "I pressed Submit". */
export function showOutdatedAlert(state: WizardState): boolean {
  if (state.outdated === null || state.deviceId !== null) return false;
  return state.submittedAt === null || state.outdated.receivedAt >= state.submittedAt;
}

/** Seconds left of the "I pressed Submit" wait, or null when not waiting. */
export function submitWaitSecondsLeft(state: WizardState, now: number): number | null {
  if (state.submittedAt === null || state.deviceId !== null || showOutdatedAlert(state)) {
    return null;
  }
  const left = state.submittedAt + SUBMIT_TIMEOUT_MS - now;
  // min: the one-second clock can lag behind the click by up to a tick.
  return left > 0 ? Math.min(Math.ceil(left / 1000), SUBMIT_TIMEOUT_MS / 1000) : null;
}

/**
 * Show the troubleshooting tips: the user pressed Submit at least 60 s ago and nothing arrived
 * (neither a pairing nor an outdated-plugin attempt). The usual cause is a URL without https://,
 * which fails silently in the plugin (PLUGIN-13).
 */
export function showTroubleshooting(state: WizardState, now: number): boolean {
  if (state.submittedAt === null || state.deviceId !== null || showOutdatedAlert(state)) {
    return false;
  }
  return now - state.submittedAt >= SUBMIT_TIMEOUT_MS;
}

/** 299_400 → "05:00", 61_000 → "01:01", 0 → "00:00" (seconds rounded up; never negative). */
export function formatCountdown(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.ceil(ms / 1000) : 0;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/** 252_000 → "4 minutes 12 seconds", 60_000 → "1 minute", 1_000 → "1 second" (screen readers). */
export function describeCountdown(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.ceil(ms / 1000) : 0;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  const parts: string[] = [];
  if (minutes > 0) parts.push(`${minutes} minute${minutes === 1 ? '' : 's'}`);
  if (seconds > 0 || minutes === 0) parts.push(`${seconds} second${seconds === 1 ? '' : 's'}`);
  return parts.join(' ');
}

/** "04817" → "0 4 8 1 7": read digit by digit by screen readers. */
export function spellDigits(code: string): string {
  return code.split('').join(' ');
}

/** The URL's scheme with "://" ("https://"), for "Copy the URL exactly, including https://". */
export function schemeOf(url: string): string {
  const m = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url);
  return m ? `${m[1]?.toLowerCase()}://` : 'https://';
}

/** "You're the owner" / "Linked as contributor; owner is Bob" (handoff §6.3 step 3). */
export function describeRole(data: Pick<DeviceFirstData, 'role' | 'ownerName'>): string {
  if (data.role === 'owner') return "You're the owner";
  return data.ownerName
    ? `Linked as contributor; owner is ${data.ownerName}`
    : 'Linked as contributor';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const CODE_RE = /^[0-9]{5}$/;

/**
 * A 201 body of POST /api/app/pairing-codes as a WizardCode, or null when malformed. The expiry is
 * moved onto the browser's clock: `receivedAt` + the code's lifetime (`ttlSeconds`, the same
 * PAIRING_CODE_TTL_SECONDS the server used), so a PC clock that is off doesn't matter.
 */
export function parseCreatedCode(
  body: unknown,
  receivedAt: number,
  ttlSeconds: number,
): WizardCode | null {
  if (!isRecord(body)) return null;
  const { id, code, baseUrl, expiresAt } = body;
  if (typeof id !== 'string' || typeof code !== 'string' || !CODE_RE.test(code)) return null;
  if (typeof baseUrl !== 'string' || typeof expiresAt !== 'string') return null;
  if (!Number.isFinite(Date.parse(expiresAt))) return null;
  const lifetimeMs = ttlSeconds * 1000;
  return { id, code, baseUrl, expiresAtMs: receivedAt + lifetimeMs, lifetimeMs };
}

/** A DeviceFirstData from JSON, or null. */
export function asDeviceFirstData(value: unknown): DeviceFirstData | null {
  if (!isRecord(value) || !isRecord(value.account)) return null;
  const { account, role, ownerName } = value;
  if (typeof account.publicId !== 'string' || typeof account.name !== 'string') return null;
  if (role !== 'owner' && role !== 'contributor') return null;
  return {
    account: {
      publicId: account.publicId,
      name: account.name,
      accountType: typeof account.accountType === 'number' ? account.accountType : null,
    },
    role,
    ownerName: typeof ownerName === 'string' ? ownerName : null,
  };
}

/**
 * A live 'pairing' message, or null when malformed (LiveProvider passes these through unchecked).
 */
export function asPairingMessage(value: unknown): PairingMessage | null {
  if (!isRecord(value) || typeof value.codeId !== 'string') return null;
  if (value.kind === 'consumed' && typeof value.deviceId === 'string') {
    return { kind: 'consumed', codeId: value.codeId, deviceId: value.deviceId };
  }
  if (value.kind === 'outdated_plugin') {
    const version = typeof value.version === 'string' ? value.version : null;
    return { kind: 'outdated_plugin', codeId: value.codeId, version };
  }
  return null;
}

/** A live 'device' message, or null when malformed (LiveProvider passes these through unchecked). */
export function asDeviceMessage(value: unknown): DeviceMessage | null {
  if (!isRecord(value) || typeof value.deviceId !== 'string') return null;
  const data = asDeviceFirstData(value);
  return data ? { deviceId: value.deviceId, ...data } : null;
}

const CODE_STATUSES = new Set(['active', 'consumed', 'expired']);

/** A 200 body of GET /api/app/pairing-codes/[id] as a PolledCodeStatus, or null when malformed. */
export function parsePolledStatus(body: unknown): PolledCodeStatus | null {
  if (!isRecord(body) || !isRecord(body.code)) return null;
  const { code } = body;
  if (typeof code.id !== 'string' || typeof code.status !== 'string') return null;
  if (!CODE_STATUSES.has(code.status)) return null;
  return {
    codeId: code.id,
    status: code.status as PolledCodeStatus['status'],
    deviceId: typeof code.deviceId === 'string' ? code.deviceId : null,
    outdatedAttemptAt: typeof code.outdatedAttemptAt === 'string' ? code.outdatedAttemptAt : null,
    outdatedVersion: typeof code.outdatedVersion === 'string' ? code.outdatedVersion : null,
    device: asDeviceFirstData(body.device),
  };
}

/** The `error.message` of an /api/app error body, else `fallback`. */
export function apiErrorMessage(body: unknown, fallback: string): string {
  if (isRecord(body) && isRecord(body.error) && typeof body.error.message === 'string') {
    return body.error.message;
  }
  return fallback;
}
