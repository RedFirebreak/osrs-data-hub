/**
 * The collection log's pieces (D-118), used by a character's log page, the card on the character
 * page and the guild's board: the headline numbers, the shelf (one card of item squares per source,
 * like the in-game log's tabs), the list of the newest slots, and the board. Server- and
 * client-safe (the icons are client leaves).
 */
import { formatNumber } from '@hub/core';
import type {
  CollectionLogGroup,
  CollectionLogSlot,
  CollectionLogTotal,
  GuildLogRow,
} from '@hub/server';
import Link from 'next/link';
import { ItemIcon } from '@/components/icons/osrs-icon';
import { MODE_LABELS } from '@/components/account-page/hiscores-content';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatInZone } from '@/lib/dates';
import { collectionLogHref } from '@/lib/routes';
import { cn } from '@/lib/utils';

/** "20 Oct 2026". */
export const DAY_OPTIONS: Intl.DateTimeFormatOptions = {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
};

/** What a slot without a source is grouped under. */
export const NO_SOURCE = 'Without a drop';

function slotDetails(slot: CollectionLogSlot, timezone: string): string {
  return [
    slot.item,
    slot.source,
    slot.killCount === null ? null : `kill count ${formatNumber(slot.killCount)}`,
    `logged ${formatInZone(slot.at, timezone, DAY_OPTIONS)}`,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** The item's icon in a small box, its name when there is none. */
export function SlotIcon({ slot, className }: { slot: CollectionLogSlot; className?: string }) {
  return (
    <ItemIcon
      itemId={slot.itemId}
      className={className}
      fallback={
        <span
          aria-hidden
          className="line-clamp-2 text-center text-[10px] leading-tight break-words"
        >
          {slot.item}
        </span>
      }
    />
  );
}

/**
 * The headline: the whole log's count from the hiscores (with rank) and its rise over 30 days, and
 * the slots the hub saw (with the newest of them when the hiscores aren't shared). A number the viewer may not see is left out, not shown as missing.
 */
export function CollectionLogTiles({
  total,
  slots,
  timezone,
}: {
  total: CollectionLogTotal | null;
  slots: readonly CollectionLogSlot[] | null;
  timezone: string;
}) {
  const mode = total && total.mode !== 'regular' ? MODE_LABELS[total.mode] : null;
  const latest = slots?.[0] ?? null;
  const tiles: { label: string; value: string; line?: string; muted?: boolean }[] = [];
  if (total) {
    tiles.push({
      label: 'Collections logged',
      value: total.score === null ? 'Not listed' : formatNumber(total.score),
      muted: total.score === null,
      line:
        total.score === null
          ? total.fetchedAt === null
            ? 'waiting for the first hiscores lookup'
            : 'not on the hiscores yet'
          : `rank ${formatNumber(total.rank)}${
              mode !== null && total.modeRank !== null
                ? ` · ${mode} rank ${formatNumber(total.modeRank)}`
                : ''
            }`,
    });
  }
  if (total) {
    tiles.push({
      label: 'Last 30 days',
      value: total.gained30 > 0 ? `+${formatNumber(total.gained30)}` : '0',
      muted: total.gained30 === 0,
      line: 'new slots on the hiscores',
    });
  }
  if (slots) {
    tiles.push({
      label: 'Seen by the hub',
      value: formatNumber(slots.length),
      line: 'new slots since RuneLite was paired',
    });
    // Without the hiscores, the newest slot fills the row.
    if (!total) {
      tiles.push({
        label: 'Newest',
        value: latest?.item ?? 'None yet',
        muted: latest === null,
        line: latest ? (formatInZone(latest.at, timezone, DAY_OPTIONS) ?? undefined) : undefined,
      });
    }
  }
  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {tiles.map((t) => (
        <div
          key={t.label}
          className="min-w-0 rounded-xl border bg-card p-3 last:odd:col-span-2 sm:last:odd:col-span-1"
        >
          <dt className="text-xs text-muted-foreground">{t.label}</dt>
          <dd
            className={cn(
              'mt-1 truncate text-xl font-semibold tabular-nums',
              t.muted && 'text-base font-normal text-muted-foreground',
            )}
          >
            {t.value}
          </dd>
          {t.line && <dd className="truncate text-xs text-muted-foreground">{t.line}</dd>}
        </div>
      ))}
    </dl>
  );
}

/** One slot as a square: the icon, the kill count in the corner, the details in the tooltip. */
export function SlotSquare({ slot, timezone }: { slot: CollectionLogSlot; timezone: string }) {
  const details = slotDetails(slot, timezone);
  return (
    <li
      title={details}
      className="relative flex aspect-square min-w-0 items-center justify-center overflow-hidden rounded-md border bg-muted/40 p-1"
    >
      <SlotIcon slot={slot} />
      {slot.killCount !== null && (
        <span
          aria-hidden
          className="absolute right-1 bottom-0.5 text-[10px] font-medium text-muted-foreground tabular-nums"
        >
          {formatNumber(slot.killCount)}
        </span>
      )}
      <span className="sr-only">{details}</span>
    </li>
  );
}

/** The slots by source, a heading and a grid of squares each. */
export function CollectionLogShelf({
  groups,
  timezone,
}: {
  groups: readonly CollectionLogGroup[];
  timezone: string;
}) {
  return (
    <div className="flex flex-col gap-5">
      {groups.map((g) => (
        <section key={g.source ?? ''} aria-label={g.source ?? NO_SOURCE}>
          <h3 className="mb-2 flex items-baseline justify-between gap-3 text-sm font-medium">
            <span className="truncate">{g.source ?? NO_SOURCE}</span>
            <span className="shrink-0 text-xs font-normal text-muted-foreground tabular-nums">
              {formatNumber(g.slots.length)} {g.slots.length === 1 ? 'slot' : 'slots'}
            </span>
          </h3>
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(3.25rem,1fr))] gap-1.5">
            {g.slots.map((s) => (
              <SlotSquare key={s.item} slot={s} timezone={timezone} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** Slots in a list, newest first: icon, item and source, kill count, the day. */
export function CollectionLogList({
  slots,
  timezone,
  compact = false,
}: {
  slots: readonly CollectionLogSlot[];
  timezone: string;
  /** Narrow columns: source under the name, no value column. */
  compact?: boolean;
}) {
  return (
    <ol className="flex flex-col divide-y">
      {slots.map((s) => (
        <li key={s.item} className="flex items-center gap-3 py-2 text-sm">
          <span className="flex size-9 shrink-0 items-center justify-center">
            <SlotIcon slot={s} className="h-7 w-8" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium">{s.item}</span>
            <span className="block truncate text-xs text-muted-foreground">
              {[s.source, compact ? formatInZone(s.at, timezone, DAY_OPTIONS) : null]
                .filter(Boolean)
                .join(' · ') || (compact ? '' : NO_SOURCE)}
            </span>
          </span>
          {s.killCount !== null && (
            <span className="shrink-0 text-right text-xs text-muted-foreground tabular-nums">
              <span className="font-medium text-foreground">{formatNumber(s.killCount)}</span> kc
            </span>
          )}
          {!compact && (
            <span className="w-24 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
              {formatInZone(s.at, timezone, DAY_OPTIONS)}
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}

/** The guild's board: rank, account, whole log, its rise over 30 days, slots seen, newest. */
export function CollectionLogBoard({
  rows,
  timezone,
}: {
  rows: readonly GuildLogRow[];
  timezone: string;
}) {
  return (
    <Table className="tabular-nums">
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead scope="col" className="w-8">
            #
          </TableHead>
          <TableHead scope="col">Account</TableHead>
          <TableHead scope="col" className="text-right">
            Logged
          </TableHead>
          <TableHead scope="col" className="hidden text-right sm:table-cell">
            30 days
          </TableHead>
          <TableHead scope="col" className="hidden text-right sm:table-cell">
            Seen by the hub
          </TableHead>
          <TableHead scope="col" className="hidden md:table-cell">
            Newest
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r, i) => (
          <TableRow key={r.publicId}>
            <TableCell className="text-muted-foreground">{i + 1}</TableCell>
            <TableHead scope="row" className="font-medium">
              <Link href={collectionLogHref(r.publicId)} className="hover:underline">
                {r.name}
              </Link>
            </TableHead>
            <TableCell className="text-right font-medium">
              {r.logged === null ? '—' : formatNumber(r.logged)}
            </TableCell>
            <TableCell className="hidden text-right sm:table-cell">
              {r.gained30 === null ? '—' : r.gained30 > 0 ? `+${formatNumber(r.gained30)}` : '0'}
            </TableCell>
            <TableCell className="hidden text-right sm:table-cell">
              {r.seen === null ? '—' : formatNumber(r.seen)}
            </TableCell>
            <TableCell className="hidden max-w-56 md:table-cell">
              {r.latest ? (
                <span className="flex items-center gap-2" title={r.latest.item}>
                  <ItemIcon itemId={r.latest.itemId} className="h-6 w-7" holdSpace />
                  <span className="min-w-0 truncate">{r.latest.item}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatInZone(r.latest.at, timezone, { day: 'numeric', month: 'short' })}
                  </span>
                </span>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
