/**
 * "What you trained": the skills that gained XP in a period, most first, each with a bar in the
 * skill's colour (its share of the most trained one), the XP gained and the level. A row opens that
 * skill's progress. Shared by the character page's week and the Progress page. Server component.
 *
 *   <TrainedSkills publicId={id} skills={metrics.skills} limit={4} />
 */
import { MAX_REAL_LEVEL, OVERALL, formatGp, formatNumber } from '@hub/core';
import Link from 'next/link';
import { SkillIcon } from '@/components/icons/osrs-icon';
import { skillHref } from '@/lib/routes';
import { skillTint } from '@/lib/skill-colors';

export interface TrainedSkill {
  skill: string;
  /** XP gained in the period. */
  gained: number;
  /** The level now (virtual past 99). */
  level: number;
}

/** The skills with a gain, most gained first (ties by name), Overall left out, at most `limit`. */
export function mostTrained<T extends TrainedSkill>(skills: readonly T[], limit?: number): T[] {
  return skills
    .filter((s) => s.skill !== OVERALL && s.gained > 0)
    .sort((a, b) => b.gained - a.gained || (a.skill < b.skill ? -1 : 1))
    .slice(0, limit);
}

export interface TrainedSkillsProps {
  publicId: string;
  skills: readonly TrainedSkill[];
  limit?: number;
  /** For the list's accessible name ("in the last 7 days"). */
  period: string;
}

export function TrainedSkills({ publicId, skills, limit, period }: TrainedSkillsProps) {
  const trained = mostTrained(skills, limit);
  const most = trained[0]?.gained ?? 1;
  return (
    <ul aria-label={`Skills trained ${period}`} className="-mx-2 flex flex-col">
      {trained.map((s) => (
        <li key={s.skill}>
          <Link
            href={skillHref(publicId, s.skill)}
            style={skillTint(s.skill)}
            className="skill-tint pressable flex items-center gap-3 rounded-lg px-2 py-2 text-sm hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            <SkillIcon skill={s.skill} holdSpace />
            <span className="flex min-w-0 flex-1 flex-col gap-1.5">
              <span className="truncate">{s.skill}</span>
              <span
                aria-hidden
                className="block h-[3px] overflow-hidden rounded-full bg-foreground/10"
              >
                <span
                  className="block h-full rounded-full bg-(--skill)"
                  style={{ width: `${Math.max(3, Math.round((s.gained / most) * 100))}%` }}
                />
              </span>
            </span>
            <span className="flex flex-col items-end tabular-nums">
              <span className="font-medium" title={`${formatNumber(s.gained)} XP`}>
                +{formatGp(s.gained)}
                <span className="sr-only"> XP</span>
              </span>
              <span className="text-xs text-muted-foreground">
                level {Math.min(s.level, MAX_REAL_LEVEL)}
              </span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
