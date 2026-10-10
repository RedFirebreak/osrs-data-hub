/**
 * The skills of a character as the game shows them: the skills tab's three columns in its own order
 * (the read model sorts the rows that way), so a player finds a skill where their hands expect it.
 * A tile has the skill's icon (D-95), its real level (the virtual one past 99 in the tooltip,
 * PLUGIN-9), a thin bar for the way to the next level in the skill's colour, and the XP gained over
 * the last 7 days when there is any. It opens that skill's progress. On a phone a tile keeps icon,
 * level and bar. Overall has no tile: the total level is in the page's header. Server component.
 */
import { MAX_REAL_LEVEL, OVERALL, formatGp, formatNumber, levelProgress } from '@hub/core';
import type { SkillRow } from '@hub/server';
import Link from 'next/link';
import { SkillIcon } from '@/components/icons/osrs-icon';
import { skillHref } from '@/lib/routes';
import { skillTint } from '@/lib/skill-colors';

export interface SkillsPanelProps {
  publicId: string;
  rows: readonly SkillRow[];
}

/** What a tile says to a screen reader, and in its tooltip. */
export function skillTileLabel(row: SkillRow): string {
  const progress = levelProgress(row.xp);
  const parts = [`${row.skill}, level ${row.realLevel}`];
  if (row.level > MAX_REAL_LEVEL) parts.push(`virtual level ${row.level}`);
  parts.push(
    progress.to === null
      ? 'at 200M XP'
      : `${Math.floor(progress.share * 100)}% of the way to ${progress.level + 1}`,
  );
  if (row.gains.week > 0) parts.push(`${formatNumber(row.gains.week)} XP gained in 7 days`);
  return parts.join(', ');
}

export function SkillsPanel({ publicId, rows }: SkillsPanelProps) {
  const skills = rows.filter((row) => row.skill !== OVERALL);
  return (
    <ul className="grid grid-cols-3 gap-1.5 sm:gap-2">
      {skills.map((row) => {
        const label = skillTileLabel(row);
        return (
          <li key={row.skill} className="min-w-0">
            <Link
              href={skillHref(publicId, row.skill)}
              aria-label={label}
              title={label}
              style={skillTint(row.skill)}
              className="skill-tint pressable flex flex-col gap-2 rounded-lg border bg-muted/50 px-2.5 py-2 hover:border-(--skill) focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              <span className="flex items-center gap-2">
                <SkillIcon skill={row.skill} holdSpace />
                <span className="hidden min-w-0 flex-1 truncate text-sm sm:block">{row.skill}</span>
                {row.gains.week > 0 && (
                  <span className="hidden text-xs font-medium text-(--skill) tabular-nums sm:block">
                    +{formatGp(row.gains.week)}
                  </span>
                )}
                <span className="ml-auto text-base leading-none font-semibold tabular-nums">
                  {row.realLevel}
                </span>
              </span>
              <span className="block h-[3px] overflow-hidden rounded-full bg-foreground/10">
                <span
                  className="block h-full rounded-full bg-(--skill)"
                  style={{ width: `${Math.round(levelProgress(row.xp).share * 100)}%` }}
                />
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
