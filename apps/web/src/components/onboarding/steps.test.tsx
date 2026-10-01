/**
 * The wizard's step views rendered to markup with given props (the state machine behind them is
 * tested in wizard-model.test.ts): what the player sees and what screen readers get.
 */
import { CATEGORIES, CATEGORY_LABELS, type Audience, type Category } from '@hub/core';
import type { SharingSettings } from '@hub/server';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { DoneSharingControls } from './done-sharing';
import { DoneStep } from './done-step';
import { FirstDataStep } from './first-data-step';
import { PairStep, type PairStepProps } from './pair-step';
import { WizardProgress } from './wizard-progress';

// The sharing controls send their changes through useApiRequest, which needs the app router.
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useRouter: () => ({ refresh() {}, push() {}, replace() {}, back() {}, prefetch() {} }),
}));

const noop = () => {};

function pairStep(overrides: Partial<PairStepProps> = {}): string {
  const props: PairStepProps = {
    code: {
      id: 'c1',
      code: '04817',
      baseUrl: 'https://hub.example.com',
      expiresAtMs: 0,
      lifetimeMs: 300_000,
    },
    codeRequest: 'idle',
    resuming: false,
    codeError: null,
    msLeft: 252_000,
    expired: false,
    connected: true,
    outdated: null,
    waitSecondsLeft: null,
    troubleshooting: false,
    minPluginVersion: '1.5',
    onRegenerate: noop,
    onSubmitted: noop,
    onBack: noop,
    ...overrides,
  };
  return renderToStaticMarkup(
    <TooltipProvider>
      <PairStep {...props} />
    </TooltipProvider>,
  );
}

/** Text content without tags (entities left as rendered). */
function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('WizardProgress', () => {
  it('marks the current step and the done ones', () => {
    const html = renderToStaticMarkup(<WizardProgress current={2} />);
    expect(html).toMatch(/<li aria-current="step"[^>]*>.*Step 2: <\/span>Pair/);
    expect(text(html)).toContain('Step 1: Install (done)');
    expect(text(html)).toContain('Step 2: Pair (current)');
    expect(text(html)).toContain('Step 4: Done');
    expect(html.match(/aria-current/g)).toHaveLength(1);
  });
});

describe('PairStep', () => {
  it('shows the code as digits (kept as a string), the exact URL and the countdown', () => {
    const html = pairStep();
    expect(html).toContain('data-code="04817"');
    expect(text(html)).toContain('Code: 0 4 8 1 7');
    expect(html).toContain('data-testid="pairing-url"');
    expect(text(html)).toContain('https://hub.example.com');
    expect(text(html)).toContain('Copy the URL exactly, including https://.');
    expect(text(html)).toContain('Expires in 04:12');
    expect(text(html)).toContain('Expires in 4 minutes 12 seconds');
    expect(html).toContain('aria-label="Copy pairing code"');
    expect(html).toContain('aria-label="Copy hub URL"');
    expect(text(html)).toContain('Waiting for RuneLite to connect');
    expect(text(html)).not.toContain('reconnecting');
    expect(text(html)).toContain('I pressed Submit');
  });

  it('names the scheme of a plain-http hub (development)', () => {
    const html = pairStep({
      code: {
        id: 'c1',
        code: '12345',
        baseUrl: 'http://127.0.0.1:3100',
        expiresAtMs: 0,
        lifetimeMs: 300_000,
      },
    });
    expect(text(html)).toContain('http://127.0.0.1:3100');
    expect(text(html)).toContain('including http://.');
  });

  it('keeps five empty digit boxes while the code is created', () => {
    const html = pairStep({ code: null, codeRequest: 'loading', msLeft: null });
    expect(html).not.toContain('data-code=');
    expect(html.match(/animate-pulse/g)?.length).toBe(5);
    expect(text(html)).toContain('Creating a code');
  });

  it('says when the code expired and offers Regenerate', () => {
    const html = pairStep({ expired: true, msLeft: 0 });
    expect(text(html)).toContain('Code expired');
    expect(text(html).match(/Code expired/g)).toHaveLength(1);
    expect(text(html)).toContain('A code is valid for 5 minutes.');
    expect(text(html)).toContain('Regenerate');
    expect(text(html)).not.toContain('Waiting for RuneLite');
  });

  it('explains an outdated plugin', () => {
    const html = pairStep({ outdated: { version: '1.4' } });
    expect(text(html)).toContain(
      'Your HA Exporter is too old (version 1.4). Restart RuneLite to update it, then press Submit again.',
    );
    expect(text(pairStep({ outdated: { version: null } }))).toContain(
      'Your HA Exporter is too old (no version sent).',
    );
  });

  it('shows the troubleshooting tips after the wait, starting with the URL scheme', () => {
    const html = pairStep({ troubleshooting: true });
    expect(html).toContain('role="alert"');
    expect(text(html)).toContain('Nothing has arrived from RuneLite yet');
    expect(text(html)).toContain('Check that the Endpoint URL starts with https://');
    expect(text(html)).toContain('fails silently');
    expect(text(html)).toContain('version 1.5 or newer');
    expect(text(html)).toContain('can reach the hub');
    expect(text(html)).toContain('I pressed Submit again');
  });

  it('counts down the Submit wait and mentions polling while the live stream is down', () => {
    const html = pairStep({ waitSecondsLeft: 42, connected: false });
    expect(text(html)).toContain('Waiting for RuneLite to connect… (42 s)');
    expect(text(html)).toContain('checking every 3 seconds');
  });

  it('keeps the per-second countdown out of live regions (no announcement every second)', () => {
    const html = pairStep({ waitSecondsLeft: 42 });
    const liveRegions = [
      ...html.matchAll(/<(\w+)[^>]*role="(?:status|alert)"[^>]*>(.*?)<\/\1>/g),
    ].map((m) => text(m[2] ?? ''));
    expect(liveRegions).toContain('Waiting for RuneLite to connect…');
    for (const region of liveRegions) expect(region).not.toMatch(/\d+ s\b/);
    // Nor the code's own countdown.
    for (const region of liveRegions) expect(region).not.toMatch(/Expires in/);
  });

  it('shows a failed code request with a retry', () => {
    const html = pairStep({ code: null, codeRequest: 'failed', codeError: 'The hub is busy.' });
    expect(text(html)).toContain('Couldn&#x27;t create a pairing code');
    expect(text(html)).toContain('The hub is busy.');
    expect(text(html)).toContain('Try again');
  });
});

describe('FirstDataStep', () => {
  it('waits for the first data, then names the account, its type and the role', () => {
    const waiting = renderToStaticMarkup(
      <FirstDataStep firstData={null} connected onContinue={noop} />,
    );
    expect(text(waiting)).toContain('RuneLite connected');
    expect(text(waiting)).toContain(
      'Log in to OSRS with any account (not on a Leagues/Deadman world).',
    );
    expect(text(waiting)).toContain('Waiting for the first data');
    expect(text(waiting)).toContain('Skip for now');

    const owner = renderToStaticMarkup(
      <FirstDataStep
        firstData={{
          account: { publicId: 'AbCdEf123456', name: 'Zezima', accountType: 1 },
          role: 'owner',
          ownerName: 'Alice',
        }}
        connected
        onContinue={noop}
      />,
    );
    expect(owner).toContain('<strong class="font-semibold">Zezima</strong>');
    expect(text(owner)).toContain('Receiving data for Zezima (Ironman)');
    expect(text(owner)).toContain('You&#x27;re the owner');

    const contributor = renderToStaticMarkup(
      <FirstDataStep
        firstData={{
          account: { publicId: 'AbCdEf123456', name: 'Shared', accountType: null },
          role: 'contributor',
          ownerName: 'Bob',
        }}
        connected
        onContinue={noop}
      />,
    );
    expect(text(contributor)).toContain('Receiving data for Shared');
    expect(text(contributor)).not.toContain('(Unknown)');
    expect(text(contributor)).toContain('Linked as contributor; owner is Bob');
  });
});

describe('DoneStep', () => {
  it("shows the owner the account's sharing controls, loading them first", () => {
    const html = renderToStaticMarkup(
      <DoneStep
        firstData={{
          account: { publicId: 'AbCdEf123456', name: 'Zezima', accountType: 0 },
          role: 'owner',
          ownerName: 'Alice',
        }}
        onRestart={noop}
      />,
    );
    expect(html).toContain('href="/"');
    expect(text(html)).toContain('Who can see Zezima');
    expect(text(html)).toContain(
      'A new account shares everything with the guild. Change any of it here; it saves right away.',
    );
    expect(html).toMatch(/role="status"[^>]*>.*Loading the sharing settings/);
    expect(text(html)).not.toContain('stay private');
    expect(text(html)).toContain('plugin settings decide what is sent');
  });

  it("tells a contributor that the owner decides, and doesn't offer settings they can't change", () => {
    const html = renderToStaticMarkup(
      <DoneStep
        firstData={{
          account: { publicId: 'AbCdEf123456', name: 'Shared Main', accountType: 0 },
          role: 'contributor',
          ownerName: 'Bob',
        }}
        onRestart={noop}
      />,
    );
    expect(text(html)).toContain('Bob owns Shared Main and decides who in the guild sees it.');
    expect(html).toContain('href="/accounts/AbCdEf123456#sharing"');
    expect(text(html)).toContain('Who can see Shared Main');
    expect(text(html)).not.toContain('Loading the sharing settings');
    expect(text(html)).not.toContain('A new account shares');
    expect(text(html)).toContain('plugin settings decide what is sent');
  });

  it('names the default and links to the sharing explanation when no account arrived yet', () => {
    const html = renderToStaticMarkup(<DoneStep firstData={null} onRestart={noop} />);
    expect(html).toContain('href="/privacy#sharing"');
    expect(text(html)).toContain('RuneLite is connected');
    expect(text(html)).toContain(
      'A new account shares everything with the guild by default; its owner can change that per category on the account&#x27;s page.',
    );
    expect(text(html)).not.toContain('stay private');
  });
});

describe('DoneSharingControls', () => {
  function settings(over: Partial<Record<Category, Audience>> = {}): SharingSettings {
    return {
      canManage: true,
      categories: CATEGORIES.map((category) => ({
        category,
        audience: over[category] ?? 'guild',
        isDefault: !(category in over),
        grants: [],
      })),
      contributors: [],
    };
  }

  it('lists every category with its audience, as on the account page', () => {
    const html = renderToStaticMarkup(
      <DoneSharingControls
        account={{ publicId: 'AbCdEf123456', name: 'Zezima' }}
        initial={settings({ inventory: 'private' })}
      />,
    );
    for (const c of CATEGORIES) {
      expect(text(html)).toContain(CATEGORY_LABELS[c].label);
      expect(text(html)).toContain(CATEGORY_LABELS[c].covers);
    }
    // One select per category, enabled for the owner.
    expect(html.match(/role="combobox"/g)).toHaveLength(CATEGORIES.length);
    expect(html).not.toMatch(/role="combobox"[^>]* disabled=""/);
    expect(text(html).match(/Guild/g)).toHaveLength(CATEGORIES.length - 1);
    expect(text(html).match(/Private/g)).toHaveLength(1);
    expect(html).toContain('href="/accounts/AbCdEf123456#sharing"');
    expect(text(html)).toContain('More sharing options for Zezima');
  });
});
