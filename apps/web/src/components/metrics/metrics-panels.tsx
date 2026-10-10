/**
 * Deep dive's panels that are text rather than charts (D-106): the totals of the range, the session recaps with their records, the skills with
 * their progress and rates, and the bosses. Server components (links carry the page's filters).
 */
import {
  MAX_REAL_LEVEL,
  formatGp,
  formatNumber,
  metricsSearch,
  type MetricsQuery,
} from '@hub/core';
import type { AccountMetrics, BossMetrics, SessionCard, SkillMetrics } from '@hub/server';
import { TrophyIcon } from 'lucide-react';
import type { Route } from 'next';
import Link from 'next/link';
import { MOMENT_OPTIONS } from '@/components/charts/options';
import { SkillIcon } from '@/components/icons/osrs-icon';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatInZone } from '@/lib/dates';
import { bossHref } from '@/lib/routes';
import { skillTint } from '@/lib/skill-colors';
import { cn } from '@/lib/utils';
import { formatEtaMs, formatMs, formatRate, formatShare } from './format';

// --- Totals --------------------------------------------------------------------------------------

function Tile({
  label,
  value,
  lines = [],
  muted = false,
}: {
  label: string;
  value: string;
  lines?: readonly string[];
  muted?: boolean;
}) {
  return (
    <div className="min-w-0 rounded-xl border bg-card p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          'mt-1 truncate text-xl font-semibold tabular-nums',
          muted && 'text-base font-normal text-muted-foreground',
        )}
      >
        {value}
      </dd>
      {lines.map((line) => (
        <dd key={line} className="truncate text-xs text-muted-foreground tabular-nums">
          {line}
        </dd>
      ))}
    </div>
  );
}

const NOT_SHARED = 'Not shared';

/**
 * XP, loot, kills and wealth change in the range, and the time played: rates are over the play
 * sessions' active and online time side by side, because the gap between them is the point.
 */
export function TotalsTiles({ m }: { m: AccountMetrics }) {
  const t = m.totals;
  const s = t.sessions;
  const rates = (amount: number | null, measure: 'xp' | 'gp') =>
    s && amount !== null && s.onlineMs > 0
      ? [
          `${formatRate(measure, s.activeMs > 0 ? (amount / s.activeMs) * 3_600_000 : null)} active`,
          `${formatRate(measure, (amount / s.onlineMs) * 3_600_000)} online`,
        ]
      : [];
  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      <Tile
        label="XP gained"
        value={t.xp === null ? NOT_SHARED : formatNumber(t.xp)}
        muted={t.xp === null}
        lines={rates(t.sessionXp, 'xp')}
      />
      <Tile
        label="Boss kills"
        value={t.kills === null ? NOT_SHARED : formatNumber(t.kills)}
        muted={t.kills === null}
        lines={t.kills === null ? [] : ['from the hiscores']}
      />
      <Tile
        label="Loot"
        value={t.gp === null ? NOT_SHARED : `${formatGp(t.gp)} gp`}
        muted={t.gp === null}
        lines={
          t.gp === null
            ? []
            : [
                `${formatNumber(t.drops)} ${t.drops === 1 ? 'drop' : 'drops'}`,
                ...rates(t.sessionGp, 'gp'),
              ].slice(0, 2)
        }
      />
      <Tile
        label="Wealth change"
        value={
          m.access.inventory
            ? t.wealthChange === null
              ? 'No data'
              : `${t.wealthChange > 0 ? '+' : ''}${formatGp(t.wealthChange)} gp`
            : NOT_SHARED
        }
        muted={!m.access.inventory || t.wealthChange === null}
        lines={m.access.inventory ? ['carried, start to end'] : []}
      />
      <Tile
        label="Active time"
        value={s ? formatMs(s.activeMs) : NOT_SHARED}
        muted={!s}
        lines={s ? [`${formatShare(s.activeMs, s.onlineMs)} of online time`] : []}
      />
      <Tile
        label="Online"
        value={s ? formatMs(s.onlineMs) : NOT_SHARED}
        muted={!s}
        lines={
          s ? [`${formatNumber(s.sessions)} ${s.sessions === 1 ? 'session' : 'sessions'}`] : []
        }
      />
    </dl>
  );
}

// --- Sessions ------------------------------------------------------------------------------------

/** Session cards shown before "Show all". */
const SESSIONS_SHOWN = 6;

const RECORD_LABELS = {
  mostXp: 'Most XP',
  mostGp: 'Most loot',
  mostKills: 'Most kills',
  longest: 'Longest',
} as const;

/** The link that opens a session's timeline, keeping the page's other filters. */
export function sessionHref(path: string, query: MetricsQuery, id: string): Route {
  return `${path}?${metricsSearch({ ...query, session: id })}#timeline` as Route;
}

export function SessionList({
  m,
  query,
  path,
  timezone,
}: {
  m: AccountMetrics;
  query: MetricsQuery;
  path: string;
  timezone: string;
}) {
  const sessions = m.sessions ?? [];
  const records = new Map<string, string[]>();
  for (const [key, label] of Object.entries(RECORD_LABELS)) {
    const id = m.records?.[key as keyof typeof RECORD_LABELS];
    if (id) records.set(id, [...(records.get(id) ?? []), label]);
  }
  if (sessions.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No play sessions in this range{m.matching ? ' match the filters' : ''}. Play outside
        RuneLite (mobile) counts towards the totals but has no sessions.
      </p>
    );
  }
  const card = (s: SessionCard) => (
    <SessionRecap
      key={s.id}
      s={s}
      records={records.get(s.id) ?? []}
      href={sessionHref(path, query, s.id)}
      selected={s.id === query.session}
      timezone={timezone}
      showGp={m.access.events}
    />
  );
  return (
    <div className="flex flex-col gap-3">
      <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {sessions.slice(0, SESSIONS_SHOWN).map(card)}
      </ul>
      {sessions.length > SESSIONS_SHOWN && (
        <details>
          <summary className="cursor-pointer text-sm text-muted-foreground select-none hover:text-foreground">
            Show all {sessions.length} sessions
          </summary>
          <ul className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {sessions.slice(SESSIONS_SHOWN).map(card)}
          </ul>
        </details>
      )}
    </div>
  );
}

function SessionRecap({
  s,
  records,
  href,
  selected,
  timezone,
  showGp,
}: {
  s: SessionCard;
  records: readonly string[];
  href: Route;
  selected: boolean;
  timezone: string;
  showGp: boolean;
}) {
  const share = s.onlineMs > 0 ? s.activeMs / s.onlineMs : 0;
  return (
    <li
      className={cn(
        'flex min-w-0 flex-col gap-2 rounded-xl border bg-card p-3 text-sm',
        selected && 'ring-2 ring-foreground/40',
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link href={href} className="font-medium hover:underline">
          {formatInZone(s.start, timezone, MOMENT_OPTIONS)}
        </Link>
        <span className="text-muted-foreground tabular-nums">
          {formatMs(s.onlineMs)}
          {s.open ? ' so far' : ''}
        </span>
      </div>
      {records.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {records.map((r) => (
            <Badge key={r} variant="outline" className="gap-1 border-foreground/30">
              <TrophyIcon aria-hidden className="size-3" />
              {r}
            </Badge>
          ))}
        </div>
      )}
      <div>
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>{s.main ? `Mostly ${s.main.name}` : 'No XP or drops'}</span>
          <span className="tabular-nums">{formatShare(s.activeMs, s.onlineMs)} active</span>
        </div>
        <div
          className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted"
          role="img"
          aria-label={`${formatShare(s.activeMs, s.onlineMs)} of the session active`}
        >
          <div className="h-full rounded-full bg-foreground" style={{ width: `${share * 100}%` }} />
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">XP</dt>
        <dd className="text-right tabular-nums">
          {formatNumber(s.xp)}
          {s.onlineMs > 0 && s.xp > 0 && (
            <span className="text-muted-foreground">
              {' '}
              · {formatRate('xp', (s.xp / s.onlineMs) * 3_600_000)}
            </span>
          )}
        </dd>
        {s.xpBySkill.slice(0, 3).map((x) => (
          <div key={x.skill} className="contents">
            <dt className="flex items-center gap-1.5 pl-2 text-muted-foreground">
              <SkillIcon skill={x.skill} className="size-4" />
              {x.skill}
            </dt>
            <dd className="text-right tabular-nums">{formatNumber(x.xp)}</dd>
          </div>
        ))}
        {s.kills.map((k) => (
          <div key={k.activity} className="contents">
            <dt className="text-muted-foreground">{k.activity}</dt>
            <dd className="text-right tabular-nums">
              {formatNumber(k.kills)} {k.kills === 1 ? 'kill' : 'kills'}
              {s.killsShared ? '*' : ''}
            </dd>
          </div>
        ))}
        {showGp && (
          <>
            <dt className="text-muted-foreground">Loot</dt>
            <dd className="text-right tabular-nums">
              {formatGp(s.gp)} gp
              {s.onlineMs > 0 && s.gp > 0 && (
                <span className="text-muted-foreground">
                  {' '}
                  · {formatRate('gp', (s.gp / s.onlineMs) * 3_600_000)}
                </span>
              )}
            </dd>
          </>
        )}
      </dl>
      {s.killsShared && (
        <p className="text-xs text-muted-foreground">
          * One hiscores reading covered this and the sessions just before it, so their kills are
          counted here together.
        </p>
      )}
    </li>
  );
}

// --- Skills --------------------------------------------------------------------------------------

/**
 * Every skill: level and progress to the next, XP gained in the range, XP per active hour while
 * training it, and the play time to the next level at that rate.
 */
export function SkillsProgress({ skills }: { skills: readonly SkillMetrics[] }) {
  const rows = [...skills].sort((a, b) => b.gained - a.gained || 0);
  const trained = rows.filter((r) => r.gained > 0);
  const rest = rows.filter((r) => r.gained === 0);
  return (
    <Table className="tabular-nums">
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead scope="col">Skill</TableHead>
          <TableHead scope="col" className="text-right">
            Level
          </TableHead>
          <TableHead scope="col" className="hidden w-40 sm:table-cell">
            To next level
          </TableHead>
          <TableHead scope="col" className="text-right">
            Gained
          </TableHead>
          <TableHead
            scope="col"
            className="hidden text-right md:table-cell"
            title="Per active hour training it"
          >
            XP/h
          </TableHead>
          <TableHead
            scope="col"
            className="hidden text-right md:table-cell"
            title="Play time at that rate"
          >
            Next level in
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {[...trained, ...rest].map((row) => (
          <TableRow key={row.skill} className={cn(row.gained === 0 && 'text-muted-foreground')}>
            <TableHead scope="row" className="font-medium">
              <span className="flex items-center gap-2">
                <SkillIcon skill={row.skill} holdSpace />
                {row.skill}
              </span>
            </TableHead>
            <TableCell className="text-right">
              {Math.min(row.level, MAX_REAL_LEVEL)}
              {row.level > MAX_REAL_LEVEL && (
                <span className="ml-1 text-xs text-muted-foreground">({row.level})</span>
              )}
            </TableCell>
            <TableCell className="hidden sm:table-cell">
              {row.nextLevelXp === null ? (
                <span className="text-xs">Maxed</span>
              ) : (
                <div
                  className="h-1.5 overflow-hidden rounded-full bg-muted"
                  role="img"
                  aria-label={`${Math.floor(row.progress * 100)}% of the way to level ${row.level + 1}, ${formatNumber(row.nextLevelXp - row.xp)} XP to go`}
                >
                  <div
                    className="skill-tint h-full rounded-full bg-(--skill)"
                    style={{ width: `${row.progress * 100}%`, ...skillTint(row.skill) }}
                  />
                </div>
              )}
            </TableCell>
            <TableCell className="text-right">
              {row.gained > 0 ? formatNumber(row.gained) : '—'}
            </TableCell>
            <TableCell className="hidden text-right md:table-cell">
              {row.xpPerHour === null ? '—' : formatGp(row.xpPerHour)}
            </TableCell>
            <TableCell className="hidden text-right md:table-cell">
              {formatEtaMs(row.etaMs)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

// --- Bosses --------------------------------------------------------------------------------------

export function BossesTable({
  bosses,
  publicId,
  query,
  showGp,
  modeLabel,
}: {
  bosses: readonly BossMetrics[];
  publicId: string;
  query: MetricsQuery;
  showGp: boolean;
  /** The iron table's name for an iron account ("Ironman"), else null. */
  modeLabel: string | null;
}) {
  // A boss page has a range of its own: it keeps this view's, not its measure or session.
  const search = metricsSearch({ ...query, session: null, measure: 'xp', skills: [], bosses: [] });
  return (
    <Table className="tabular-nums">
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead scope="col">Boss</TableHead>
          <TableHead scope="col" className="text-right">
            Kills
          </TableHead>
          <TableHead scope="col" className="text-right">
            In range
          </TableHead>
          {showGp && (
            <TableHead scope="col" className="hidden text-right sm:table-cell">
              Loot in range
            </TableHead>
          )}
          <TableHead scope="col" className="hidden text-right md:table-cell">
            Rank
          </TableHead>
          {modeLabel !== null && (
            <TableHead scope="col" className="hidden text-right md:table-cell">
              {modeLabel} rank
            </TableHead>
          )}
        </TableRow>
      </TableHeader>
      <TableBody>
        {bosses.map((b) => (
          <TableRow key={b.activity} className={cn(b.gained === 0 && 'text-muted-foreground')}>
            <TableHead scope="row" className="font-medium">
              <Link href={bossHref(publicId, b.activity, search)} className="hover:underline">
                {b.activity}
              </Link>
            </TableHead>
            <TableCell className="text-right">{formatNumber(b.score)}</TableCell>
            <TableCell className="text-right">
              {b.gained > 0 ? `+${formatNumber(b.gained)}` : '—'}
            </TableCell>
            {showGp && (
              <TableCell className="hidden text-right sm:table-cell">
                {b.gp ? `${formatGp(b.gp)} gp` : '—'}
              </TableCell>
            )}
            <TableCell className="hidden text-right md:table-cell">
              {formatNumber(b.rank)}
            </TableCell>
            {modeLabel !== null && (
              <TableCell className="hidden text-right md:table-cell">
                {formatNumber(b.modeRank)}
              </TableCell>
            )}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
