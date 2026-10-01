/**
 * Privacy (handoff §16, public): what is stored and for how long (the retention table of
 * ARCHITECTURE §8, with this deployment's values from getConfig()), who can see what (the sharing
 * categories and defaults, handoff §10), that the plugin decides what is sent (D-4), hosting in the
 * Netherlands (GDPR), the icon server the browser loads pictures from (D-95), and what "Download my
 * data" (D-79) and "Delete my data" (D-78) do.
 */
import { CATEGORIES, CATEGORY_LABELS, DEFAULT_AUDIENCE, getConfig, type Audience } from '@hub/core';
import { SELF_DELETE_UNDO_DAYS } from '@hub/server';
import type { Metadata } from 'next';
import Link from 'next/link';
import { connection } from 'next/server';
import { HubMark } from '@/components/shell/hub-mark';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatDays, formatHours } from './durations';

export function generateMetadata(): Metadata {
  return { title: `Privacy · ${getConfig().hubName}` };
}

const AUDIENCE_LABELS: Readonly<Record<Audience, string>> = {
  private: 'Private',
  guild: 'Guild',
  selected: 'Selected people',
};

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <h2 id={id} className="text-lg font-semibold tracking-tight">
        {title}
      </h2>
      {children}
    </section>
  );
}

export default async function PrivacyPage() {
  // Read the retention settings at request time, not at build time.
  await connection();
  const config = getConfig();
  const guild = config.discord.guildName;
  // The icon CDN the browser loads pictures from (D-95); null when icons are off.
  const iconsHost = config.osrsIconsUrl ? new URL(config.osrsIconsUrl).host : null;

  const retention: { data: string; kept: string }[] = [
    {
      data: 'Current state of each account: skills, gear, inventory, location, online status',
      kept: 'While the account exists',
    },
    { data: 'XP history in 5-minute detail', kept: formatDays(config.xpRawRetentionDays) },
    { data: 'Hourly and daily XP history', kept: 'No expiry' },
    {
      data: 'Events: loot, level-ups, deaths, collection log, diaries, combat tasks, superiors',
      kept: 'No expiry',
    },
    { data: 'Play sessions, equipment changes, daily wealth', kept: 'No expiry' },
    {
      data: 'Location trail (at most one point per minute)',
      kept: formatDays(config.locationRetentionDays),
    },
    {
      data: 'Raw plugin messages, for troubleshooting (admins only)',
      kept: formatHours(config.rawPayloadRetentionHours),
    },
    {
      data: 'Audit log of admin and sharing actions',
      kept: formatDays(config.auditLogRetentionDays),
    },
  ];

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b">
        <div className="mx-auto flex h-14 w-full max-w-3xl items-center gap-2 px-4 sm:px-6">
          <Link href="/" className="flex min-w-0 items-center gap-2 font-semibold">
            <HubMark />
            <span className="truncate">{config.hubName}</span>
          </Link>
          <Link
            href="/"
            className="ml-auto text-sm text-muted-foreground underline-offset-4 hover:underline"
          >
            Back to the hub
          </Link>
        </div>
      </header>
      <main
        id="main"
        className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-4 py-8 text-sm leading-relaxed sm:px-6"
      >
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">Privacy</h1>
          <p className="text-muted-foreground">
            {config.hubName} is run for the members of {guild}. It stores what the HA Exporter
            RuneLite plugin sends about your Old School RuneScape accounts, and shows it to you and
            the guild following the sharing settings below. It is hosted in the Netherlands and
            follows the GDPR.
          </p>
        </div>

        <Section id="plugin" title="The plugin decides what is sent">
          <p>
            You choose in the HA Exporter plugin settings in RuneLite which data (inventory,
            equipment, location) and which events (types, tiers, value thresholds) are sent. The hub
            stores only what arrives. It never fills in what you didn&apos;t send from other data,
            and never makes up events or toasts from it: a section the plugin doesn&apos;t send
            shows as &quot;Not shared&quot;. Nothing is sent from Leagues, Deadman and other special
            worlds unless you turn that on in the plugin; if you do, the hub keeps only the events
            and play sessions from those worlds, marked as such.
          </p>
        </Section>

        <Section id="stored" title="What is stored and for how long">
          <div className="overflow-x-auto rounded-lg ring-1 ring-foreground/10">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Data</TableHead>
                  <TableHead className="sm:w-44">Kept for</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {retention.map((row) => (
                  <TableRow key={row.data}>
                    <TableCell className="whitespace-normal">{row.data}</TableCell>
                    <TableCell className="whitespace-normal">{row.kept}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <p className="text-muted-foreground">
            Long-term XP history is kept at hourly and daily detail only. If the hub&apos;s optional
            nightly backups are on, deleted data can remain in them for up to about two months (by
            default 14 daily and 8 weekly copies) before they rotate out.
          </p>
        </Section>

        <Section id="about-you" title="About you">
          <ul className="ml-5 list-disc space-y-1.5">
            <li>
              From Discord: your user id, display name, server nickname, avatar and your roles in{' '}
              {guild}, to check that you may sign in and who is an admin. The hub never asks for
              your email and doesn&apos;t keep your Discord login tokens.
            </li>
            <li>
              Your devices: the name you give them, the plugin version, when and from which IP
              address they last sent data. Their access token is stored only as a one-way hash.
            </li>
            <li>
              One cookie keeps you signed in; it expires about a week after you last used the hub.
              For each sign-in the hub keeps the IP address and browser it came from until it
              expires. There is no tracking or advertising.
            </li>
            {iconsHost && (
              <li>
                Item, skill and equipment-slot pictures load from {iconsHost}, an icon server for
                OSRS tools. Your browser fetches them directly, so that server sees your IP address
                and which pictures a page shows, as any website would; nothing else about you or
                your accounts is sent to it.
              </li>
            )}
            <li>Your settings (toast filter, time zone).</li>
          </ul>
        </Section>

        <Section id="sharing" title="Who can see what">
          <p>
            Account data is shared by category. The account&apos;s owner (by default the first
            player whose plugin reported it) chooses per category who sees it:{' '}
            <strong>Private</strong> (the owner and the players who also play the account),{' '}
            <strong>Guild</strong> (every active member) or <strong>Selected people</strong>. A new
            account starts with the defaults below; its owner sees them, and can change them, on the
            last step of pairing and on the account&apos;s page. An account the hub knew before a
            default changed keeps what it had until its owner changes it.
          </p>
          <div className="overflow-x-auto rounded-lg ring-1 ring-foreground/10">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Category</TableHead>
                  <TableHead>Covers</TableHead>
                  <TableHead className="sm:w-28">Default</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {CATEGORIES.map((category) => {
                  const audience = DEFAULT_AUDIENCE[category];
                  return (
                    <TableRow key={category}>
                      <TableCell className="font-medium">
                        {CATEGORY_LABELS[category].label}
                      </TableCell>
                      <TableCell className="whitespace-normal">
                        {CATEGORY_LABELS[category].covers}
                      </TableCell>
                      <TableCell>
                        <Badge variant={audience === 'private' ? 'outline' : 'secondary'}>
                          {AUDIENCE_LABELS[audience]}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          <p className="text-muted-foreground">
            Where a death or a superior spawn happened is hidden from anyone who may not see the
            account&apos;s location. Admins of {guild} see that every account exists (also accounts
            hidden while their owner is away) and can change its sharing settings; their own view of
            each section follows the same rules as everyone else&apos;s. To troubleshoot, admins can
            open the raw plugin messages of the last {formatHours(config.rawPayloadRetentionHours)},
            which contain everything the plugin sent; every message an admin opens is recorded in
            the audit log.
          </p>
        </Section>

        <Section id="leaving" title="When you leave the guild">
          <p>
            Your devices stop being accepted at once and you are signed out. After{' '}
            {formatDays(config.offboardGraceDays)} your user, devices and settings are deleted,
            together with the data of accounts no other active member plays. Accounts someone else
            still plays keep their history with them. If you sign in again within that time, your
            access and your hidden accounts come back; your devices have to be paired again, and an
            account handed to another player meanwhile stays theirs. If an admin removed you, only
            an admin can undo it.
          </p>
        </Section>

        <Section id="export" title="Getting a copy of your data">
          <p>
            <strong>Download my data</strong> in Settings gives you one JSON file with your profile
            and settings, your devices and API keys (never their secrets), your sign-ins, the
            sharing settings you made and the access others gave you, the audit log entries about
            you, and every account you own or play on: its current state, XP history (5-minute
            detail for as long as it is kept, daily before that), events, play sessions, equipment
            changes, wealth per day and the location trail. It holds only what you can see in the
            hub today, so a category an owner doesn&apos;t share with you isn&apos;t in it. It
            leaves out the raw plugin messages kept for{' '}
            {formatHours(config.rawPayloadRetentionHours)} for troubleshooting, and anything about
            other members beyond the names the hub shows you. You can download it once every 10
            minutes.
          </p>
        </Section>

        <Section id="delete" title="Getting your data deleted">
          <p>
            <strong>Delete my data</strong> in Settings works like leaving the guild, with{' '}
            {formatDays(SELF_DELETE_UNDO_DAYS)} to change your mind: your devices and API keys stop
            working at once and you are signed out, and accounts you own pass to the player who has
            played them with you the longest, or are hidden. After{' '}
            {formatDays(SELF_DELETE_UNDO_DAYS)} your user, devices and settings are deleted,
            together with the data of accounts no other active member plays; accounts someone else
            still plays keep their history, and the audit log entries about you no longer name you.
            Signing in again before then cancels it; your devices have to be paired again. You can
            also ask an admin of {guild} to remove you. Under the GDPR you can also ask what is
            stored about you and have it corrected.
          </p>
        </Section>
      </main>
    </div>
  );
}
