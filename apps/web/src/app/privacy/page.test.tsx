import { getConfig, parseConfig, setConfigForTests } from '@hub/core';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import PrivacyPage from './page';

vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  connection: () => Promise.resolve(),
}));

beforeAll(() => {
  setConfigForTests(
    parseConfig({
      APP_URL: 'http://hub.test',
      HUB_NAME: 'Test Hub',
      DATABASE_URL: 'postgres://hub@localhost/hub',
      AUTH_SECRET: 'test-auth-secret-0123456789abcdefghijklmnop',
      DISCORD_GUILD_ID: '100000000000000001',
      DISCORD_GUILD_NAME: 'Iron Lads',
      DISCORD_CLIENT_ID: 'test-client-id',
      DISCORD_CLIENT_SECRET: 'test-client-secret',
      XP_RAW_RETENTION_DAYS: '400',
      LOCATION_RETENTION_DAYS: '14',
      RAW_PAYLOAD_RETENTION_HOURS: '48',
      OFFBOARD_GRACE_DAYS: '21',
    }),
  );
});
afterAll(() => setConfigForTests(undefined));

async function render(): Promise<string> {
  const html = renderToStaticMarkup(<TooltipProvider>{await PrivacyPage()}</TooltipProvider>);
  // Text only, so assertions don't depend on markup between words.
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ');
}

describe('privacy page', () => {
  it("shows this deployment's retention settings", async () => {
    const text = await render();
    expect(text).toContain('XP history in 5-minute detail 400 days');
    expect(text).toContain('14 days');
    expect(text).toContain('48 hours (2 days)');
    expect(text).toContain('After 21 days');
    expect(text).toContain('Iron Lads');
  });

  it('says exactly what admins can see: every account exists, raw messages audited, not private sections', async () => {
    const text = await render();
    expect(text).not.toContain('can see every account');
    expect(text).toMatch(/raw plugin messages of the last 48 hours/i);
    expect(text).toMatch(/audit log/i);
  });

  it('says that connected services can ask whether a Discord account is a member and an admin (D-100)', async () => {
    const text = await render();
    expect(text).toMatch(
      /Services an admin connects to the hub, such as the guild's live map, can ask whether a Discord account is a member of the hub and an admin\./,
    );
  });

  it('does not promise that everything comes back after returning to the guild', async () => {
    const text = await render();
    expect(text).not.toContain('everything is restored');
    expect(text).toMatch(/pair(ed)? again/);
  });

  it('describes the download and the 7-day delete that Settings offers (D-78, D-79)', async () => {
    const text = await render();
    expect(text).not.toMatch(/are coming|coming soon/i);
    expect(text).toContain('Download my data');
    expect(text).toMatch(/never their secrets/);
    expect(text).toMatch(/raw plugin messages kept for 48 hours \(2 days\) for troubleshooting/);
    expect(text).toContain('once every 10 minutes');
    expect(text).toContain('Delete my data');
    expect(text).toContain('7 days to change your mind');
    expect(text).toMatch(/Signing in again before then cancels it/);
  });

  it('names the icon server the browser loads pictures from, and not when icons are off (D-95)', async () => {
    const text = await render();
    expect(text).toContain('pictures load from icons.scapekeeper.com');
    expect(text).toMatch(/sees your IP address/);
    const before = getConfig();
    setConfigForTests(parseConfig({ APP_URL: 'http://hub.test', OSRS_ICONS_URL: '' }));
    try {
      expect(await render()).not.toContain('icon server');
    } finally {
      setConfigForTests(before);
    }
  });
});
