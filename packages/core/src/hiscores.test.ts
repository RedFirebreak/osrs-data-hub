import { fixtureJson } from '@hub/fixtures';
import { describe, expect, it } from 'vitest';
import {
  activityKind,
  hiscoreDue,
  hiscoreModeForAccountType,
  hiscoreUrl,
  levelForXp,
  parseHiscores,
  planHiscoreXp,
  planScoreRows,
  readStoredHiscores,
  type HiscoreSkill,
} from './hiscores';
import { overallXp, totalLevel } from './skills';

const BASE = 'https://secure.runescape.com';

describe('hiscoreModeForAccountType', () => {
  it('maps the solo iron types to their table and everything else to the main one', () => {
    expect(hiscoreModeForAccountType(0)).toBe('regular');
    expect(hiscoreModeForAccountType(1)).toBe('ironman');
    expect(hiscoreModeForAccountType(2)).toBe('ultimate_ironman');
    expect(hiscoreModeForAccountType(3)).toBe('hardcore_ironman');
    for (const gim of [4, 5, 6]) expect(hiscoreModeForAccountType(gim)).toBe('regular');
    expect(hiscoreModeForAccountType(null)).toBe('regular');
    expect(hiscoreModeForAccountType(undefined)).toBe('regular');
  });
});

describe('hiscoreUrl', () => {
  it('builds the index_lite.json lookup of each table', () => {
    expect(hiscoreUrl(BASE, 'regular', 'Lynx Titan')).toBe(
      `${BASE}/m=hiscore_oldschool/index_lite.json?player=Lynx%20Titan`,
    );
    expect(hiscoreUrl(BASE, 'ultimate_ironman', 'a')).toBe(
      `${BASE}/m=hiscore_oldschool_ultimate/index_lite.json?player=a`,
    );
    expect(hiscoreUrl(BASE, 'hardcore_ironman', 'a')).toContain(
      'm=hiscore_oldschool_hardcore_ironman/',
    );
  });

  it('sends the name as RuneLite does (toJagexName), escaped', () => {
    expect(hiscoreUrl(BASE, 'regular', 'Iron Mira')).toContain('player=Iron%20Mira');
    expect(hiscoreUrl(BASE, 'regular', 'a&b=c')).toContain('player=a%26b%3Dc');
  });
});

describe('parseHiscores', () => {
  const body = {
    name: 'Alpha',
    skills: [
      { id: 0, name: 'Overall', rank: 1641575, level: 1466, xp: 27957906 },
      { id: 1, name: 'Attack', rank: 1619914, level: 76, xp: 1343681 },
      { id: 3, name: 'Strength', rank: -1, level: 75, xp: 1271864 },
      { id: 4, name: 'Hitpoints', rank: -1, level: 1, xp: -1 },
    ],
    activities: [
      { id: 0, name: 'Grid Points', rank: -1, score: -1 },
      { id: 15, name: 'PvP Arena - Rank', rank: -1, score: 2461 },
      { id: 87, name: 'Wintertodt', rank: 37401, score: 702 },
    ],
  };

  it('reads rows by name and turns -1 into null', () => {
    expect(parseHiscores(body)).toEqual({
      skills: [
        { name: 'Overall', rank: 1641575, level: 1466, xp: 27957906 },
        { name: 'Attack', rank: 1619914, level: 76, xp: 1343681 },
        { name: 'Strength', rank: null, level: 75, xp: 1271864 },
        { name: 'Hitpoints', rank: null, level: 1, xp: null },
      ],
      activities: [
        { name: 'Grid Points', rank: null, score: null },
        { name: 'PvP Arena - Rank', rank: null, score: 2461 },
        { name: 'Wintertodt', rank: 37401, score: 702 },
      ],
    });
  });

  it('skips malformed rows and keeps the rest', () => {
    const parsed = parseHiscores({
      skills: [
        { name: 'Overall', rank: 1, level: 2277, xp: 1e9 },
        { rank: 1, level: 1, xp: 1 },
        'x',
        { name: 'Attack', rank: 1.5, level: 'x', xp: 1e30 },
      ],
      activities: [null, { name: 'Zulrah', rank: 5, score: 100 }],
    });
    expect(parsed?.skills).toEqual([
      { name: 'Overall', rank: 1, level: 2277, xp: 1e9 },
      { name: 'Attack', rank: null, level: 1, xp: null },
    ]);
    expect(parsed?.activities).toEqual([{ name: 'Zulrah', rank: 5, score: 100 }]);
  });

  it('is null for anything that is not the hiscores', () => {
    expect(parseHiscores(null)).toBeNull();
    expect(parseHiscores('<html>')).toBeNull();
    expect(parseHiscores({ skills: [] })).toBeNull();
    expect(parseHiscores({ skills: [], activities: [] })).toBeNull();
    expect(
      parseHiscores({ skills: [{ name: 'Attack', rank: 1, level: 1, xp: 0 }], activities: [] }),
    ).toBeNull();
  });
});

describe('activityKind', () => {
  it('tells clues and minigames from bosses, and counts unknown rows as bosses', () => {
    expect(activityKind('Clue Scrolls (all)')).toBe('clue');
    expect(activityKind('Clue Scrolls (master)')).toBe('clue');
    expect(activityKind('LMS - Rank')).toBe('activity');
    expect(activityKind('Collections Logged')).toBe('activity');
    expect(activityKind('Zulrah')).toBe('boss');
    expect(activityKind('Wintertodt')).toBe('boss');
    expect(activityKind('Some Boss Jagex Adds Next Year')).toBe('boss');
  });
});

describe('levelForXp', () => {
  it('gives the virtual level the plugin sends for every skill of the fixture', () => {
    type Skills = Record<string, { xp: number; level: number }>;
    const skills = fixtureJson<{ player: { stats: { skills: Skills } } }>('snapshot-normal').player
      .stats.skills;
    for (const { xp, level } of Object.values(skills)) expect(levelForXp(xp)).toBe(level);
  });

  it('follows the experience table at its edges', () => {
    expect(levelForXp(0)).toBe(1);
    expect(levelForXp(82)).toBe(1);
    expect(levelForXp(83)).toBe(2);
    expect(levelForXp(1154)).toBe(10);
    expect(levelForXp(13_034_430)).toBe(98);
    expect(levelForXp(13_034_431)).toBe(99);
    expect(levelForXp(200_000_000)).toBe(126);
  });
});

describe('planHiscoreXp', () => {
  const prev = {
    Attack: { xp: 1000, level: 9 },
    Cooking: { xp: 2000, level: 13 },
    Sailing: { xp: 500, level: 5 },
  };
  const row = (name: string, xp: number | null, rank: number | null = 10): HiscoreSkill => ({
    name,
    rank,
    level: 1,
    xp,
  });

  it('writes the skills the hiscores have higher, then Overall over the merged skills', () => {
    const plan = planHiscoreXp(prev, [
      row('Overall', 999_999),
      row('Attack', 1000),
      row('Cooking', 13_034_431),
      row('Sailing', 500),
    ]);
    const merged = { ...prev, Cooking: { xp: 13_034_431, level: 99 } };
    expect(plan).toEqual({
      writes: [
        { skill: 'Cooking', xp: 13_034_431, level: 99 },
        { skill: 'Overall', xp: overallXp(merged), level: totalLevel(merged) },
      ],
      skills: merged,
      mismatchSkill: null,
    });
  });

  it('writes nothing when nothing is higher', () => {
    expect(planHiscoreXp(prev, [row('Attack', 1000), row('Cooking', 2000)])).toEqual({
      writes: [],
      skills: null,
      mismatchSkill: null,
    });
  });

  it('is a mismatch, with no writes, when a ranked skill is lower than the hub has it', () => {
    expect(planHiscoreXp(prev, [row('Cooking', 1_000_000), row('Attack', 999)])).toEqual({
      writes: [],
      skills: null,
      mismatchSkill: 'Attack',
    });
  });

  it('ignores unranked rows, unknown XP and skills the plugin never reported', () => {
    expect(
      planHiscoreXp(prev, [
        row('Attack', 0, null),
        row('Cooking', null),
        row('Sailing', 0, null),
        row('Hunter', 5_000_000),
      ]),
    ).toEqual({ writes: [], skills: null, mismatchSkill: null });
  });
});

describe('hiscoreDue', () => {
  const now = new Date('2026-10-09T12:00:00Z');
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const MIN = 60_000;
  const lookup = {
    name: 'Alpha',
    mode: 'regular' as const,
    lastAttemptAt: ago(60 * MIN),
    nextAttemptAt: null,
  };
  const base = { name: 'Alpha', mode: 'regular' as const, online: false, lastSessionEnd: null };

  it('looks up a new account at once, online or not', () => {
    expect(hiscoreDue({ ...base, lookup: null }, now)).toBe('new');
    expect(hiscoreDue({ ...base, online: true, lookup: null }, now)).toBe('new');
  });

  it('waits while the account is online', () => {
    expect(hiscoreDue({ ...base, online: true, name: 'Bravo', lookup }, now)).toBeNull();
    expect(
      hiscoreDue(
        { ...base, online: true, lookup: { ...lookup, lastAttemptAt: ago(25 * 60 * MIN) } },
        now,
      ),
    ).toBeNull();
  });

  it('looks up a renamed account or a new mode, even while waiting after not_found', () => {
    const waiting = { ...lookup, nextAttemptAt: new Date(now.getTime() + 60 * MIN) };
    expect(hiscoreDue({ ...base, name: 'Bravo', lookup: waiting }, now)).toBe('renamed');
    expect(hiscoreDue({ ...base, mode: 'ironman', lookup }, now)).toBe('renamed');
    // The game's own name comparison: case, NBSP, '_' and '-' don't make a rename.
    expect(hiscoreDue({ ...base, name: 'alpha', lookup }, now)).toBeNull();
    expect(
      hiscoreDue({ ...base, name: 'Iron_Mira', lookup: { ...lookup, name: 'Iron Mira' } }, now),
    ).toBeNull();
  });

  it('looks up 10 minutes after a session that ended since the last lookup', () => {
    expect(hiscoreDue({ ...base, lastSessionEnd: ago(9 * MIN), lookup }, now)).toBeNull();
    expect(hiscoreDue({ ...base, lastSessionEnd: ago(10 * MIN), lookup }, now)).toBe('session');
    expect(hiscoreDue({ ...base, lastSessionEnd: ago(61 * MIN), lookup }, now)).toBeNull();
  });

  it('looks up once a day otherwise', () => {
    expect(
      hiscoreDue({ ...base, lookup: { ...lookup, lastAttemptAt: ago(24 * 60 * MIN - 1) } }, now),
    ).toBeNull();
    expect(
      hiscoreDue({ ...base, lookup: { ...lookup, lastAttemptAt: ago(24 * 60 * MIN) } }, now),
    ).toBe('daily');
  });

  it('respects the wait after not_found or a mismatch', () => {
    const waiting = {
      ...lookup,
      lastAttemptAt: ago(25 * 60 * MIN),
      nextAttemptAt: new Date(now.getTime() + 1),
    };
    expect(hiscoreDue({ ...base, lastSessionEnd: ago(20 * MIN), lookup: waiting }, now)).toBeNull();
    expect(hiscoreDue({ ...base, lookup: { ...waiting, nextAttemptAt: now } }, now)).toBe('daily');
  });
});

describe('readStoredHiscores', () => {
  it('reads back what parseHiscores produced, and skips rows of another shape', () => {
    const parsed = parseHiscores({
      skills: [
        { name: 'Overall', rank: 5, level: 100, xp: 1000 },
        { name: 'Attack', rank: -1, level: 1, xp: -1 },
      ],
      activities: [{ name: 'Zulrah', rank: -1, score: 12 }],
    });
    expect(readStoredHiscores(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
    expect(
      readStoredHiscores({
        skills: [
          { name: 'Attack', rank: -1, level: 1, xp: 5 },
          { name: 'Defence', level: 1 },
        ],
        activities: [{ name: 'Zulrah', rank: null, score: 'x' }],
      }),
    ).toEqual({ skills: [], activities: [] });
    expect(readStoredHiscores(null)).toBeNull();
    expect(readStoredHiscores({ skills: [] })).toBeNull();
  });
});

describe('planScoreRows', () => {
  const acts = (...rows: [string, number | null][]) =>
    rows.map(([name, score]) => ({ name, rank: null, score }));

  it('makes every known score a baseline when the lookup starts a series', () => {
    expect(
      planScoreRows(null, acts(['Zulrah', 50], ['Vorkath', null], ['Clue Scrolls (all)', 0])),
    ).toEqual([
      { activity: 'Zulrah', score: 50, baseline: true },
      { activity: 'Clue Scrolls (all)', score: 0, baseline: true },
    ]);
  });

  it('continues a series: changed scores are rows, a first appearance is a baseline', () => {
    const prev = new Map([
      ['Zulrah', 50],
      ['Vorkath', 7],
    ]);
    expect(
      planScoreRows(prev, acts(['Zulrah', 60], ['Vorkath', 7], ['Vardorvis', 5], ['Yama', null])),
    ).toEqual([
      { activity: 'Zulrah', score: 60, baseline: false },
      { activity: 'Vardorvis', score: 5, baseline: true },
    ]);
  });
});
