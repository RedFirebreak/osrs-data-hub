'use client';
/**
 * The skill picker above a per-skill view (the account page's XP chart, the guild leaderboards): a
 * compact select labelled "Skill" for screen readers, listing the skills in the order given.
 *
 *   const [skill, setSkill] = useState(() => defaultSkill(skills));
 *   <SkillSelect skills={skills} value={skill} onChange={setSkill} />
 */
import { OVERALL } from '@hub/core';
import { useId } from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

/** The skill a picker starts on: Overall when it is offered, else the first skill ('' for none). */
export function defaultSkill(skills: readonly string[]): string {
  return skills.includes(OVERALL) ? OVERALL : (skills[0] ?? '');
}

export interface SkillSelectProps {
  /** Skills to choose from, Overall first. */
  skills: readonly string[];
  value: string;
  onChange: (skill: string) => void;
  /** How the list lines up with the trigger (default centred; `end` at a row's right end). */
  align?: 'start' | 'center' | 'end';
  /** Classes of the wrapper around the label and the select. */
  className?: string;
}

export function SkillSelect({ skills, value, onChange, align, className }: SkillSelectProps) {
  const id = useId();
  return (
    <div className={className}>
      <label htmlFor={`${id}-skill`} className="sr-only">
        Skill
      </label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={`${id}-skill`} size="sm" className="min-w-36">
          <SelectValue placeholder="Skill" />
        </SelectTrigger>
        <SelectContent position="popper" align={align} className="max-h-72">
          {skills.map((s) => (
            <SelectItem key={s} value={s}>
              {s}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
