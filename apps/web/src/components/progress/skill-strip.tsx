/**
 * Every skill as its icon, in the game's order: on a skill's page, the way sideways to the next
 * skill without going back up. Every icon is at full strength (the dark sprites would vanish if the
 * others were dimmed); the current one is marked by its frame. The row scrolls on a phone. Each link
 * keeps the page's range. Server component.
 */
import Link from 'next/link';
import { SkillIcon } from '@/components/icons/osrs-icon';
import { skillHref } from '@/lib/routes';
import { cn } from '@/lib/utils';

export interface SkillStripProps {
  publicId: string;
  /** The character's skills, in display order, without Overall. */
  skills: readonly string[];
  current: string;
  /** The page's query string without "?" (progressSearch), kept on every link. */
  search: string;
}

export function SkillStrip({ publicId, skills, current, search }: SkillStripProps) {
  return (
    <nav aria-label="Skills" className="-mx-1 overflow-x-auto [scrollbar-width:thin]">
      <ul className="flex w-max gap-1 p-1">
        {skills.map((skill) => {
          const on = skill === current;
          return (
            <li key={skill}>
              <Link
                href={skillHref(publicId, skill, search)}
                aria-current={on ? 'page' : undefined}
                aria-label={skill}
                title={skill}
                className={cn(
                  'pressable grid size-9 place-items-center rounded-lg border border-transparent focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
                  on ? 'border-foreground/60 bg-muted' : 'hover:bg-muted',
                )}
              >
                <SkillIcon skill={skill} holdSpace fallback={<span>{skill.slice(0, 2)}</span>} />
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
