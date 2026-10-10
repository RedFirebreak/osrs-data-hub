/**
 * Metrics goals (D-109): a target level or XP in a skill, or a kill count on the hiscores, per
 * account. The owner sets and removes them; whoever may read the category a goal is about sees it
 * (`stats` for level and XP, `hiscores` for a kill count), with its progress and an ETA at the pace
 * of the range being looked at.
 */
import {
  MAX_SKILL_XP,
  MAX_VIRTUAL_LEVEL,
  OVERALL,
  levelForXp,
  xpForLevel,
  type Principal,
  type Viewer,
} from '@hub/core';
import {
  GOAL_KINDS,
  accountGoals,
  skills as skillsTable,
  type DbOrTx,
  type GoalKind,
} from '@hub/db';
import { and, asc, count, eq } from 'drizzle-orm';
import { loadVisibleAccount, type AccountWithAccess } from '../accounts/load';

export { GOAL_KINDS, type GoalKind };

/** Goals one account may have. */
export const MAX_GOALS = 20;
/** The largest kill count a goal may ask for. */
export const MAX_KC_GOAL = 10_000_000;

export interface GoalRow {
  id: string;
  kind: GoalKind;
  target: string;
  value: number;
  createdAt: string;
}

export interface GoalView extends GoalRow {
  /** The current level, XP or kill count; null when unknown (not shared, or not on the hiscores). */
  current: number | null;
  /** 0…1. */
  progress: number | null;
  /** What is left to gain, in XP for level goals (levels aren't linear). */
  remaining: number | null;
  /** XP or kills gained per day over the range looked at. */
  perDay: number | null;
  /** Days to go at that pace: 0 when reached, null without a pace. */
  etaDays: number | null;
}

export type GoalErrorCode = 'not_found' | 'forbidden' | 'invalid' | 'limit';

/** A refused goal change; routes map the code to 404, 403, 400 and 409. The message is safe to show. */
export class GoalError extends Error {
  override name = 'GoalError';
  constructor(
    readonly code: GoalErrorCode,
    message: string = code,
  ) {
    super(message);
  }
}

/** The category a goal of this kind needs. */
export function goalCategory(kind: GoalKind): 'stats' | 'hiscores' {
  return kind === 'kc' ? 'hiscores' : 'stats';
}

/** The account's goals the viewer may see (by category), oldest first. */
export async function readGoals(db: DbOrTx, entry: AccountWithAccess): Promise<GoalRow[]> {
  const rows = await db
    .select({
      id: accountGoals.id,
      kind: accountGoals.kind,
      target: accountGoals.target,
      value: accountGoals.value,
      createdAt: accountGoals.createdAt,
    })
    .from(accountGoals)
    .where(eq(accountGoals.accountId, entry.account.id))
    .orderBy(asc(accountGoals.createdAt), asc(accountGoals.id));
  return rows
    .filter((r) => entry.access.categories.has(goalCategory(r.kind)))
    .map((r) => ({ ...r, value: Number(r.value), createdAt: r.createdAt.toISOString() }));
}

export interface GoalContext {
  /** Current XP by skill. */
  xp: ReadonlyMap<string, number>;
  /** Current kill counts by hiscores activity. */
  kc: ReadonlyMap<string, number>;
  /** Gains over the range: XP by skill and kills by activity. */
  xpGained: ReadonlyMap<string, number>;
  killsGained: ReadonlyMap<string, number>;
  /** The range's length in days. */
  days: number;
}

/** Goals with their progress and ETA. Pure. */
export function toGoalViews(goals: readonly GoalRow[], ctx: GoalContext): GoalView[] {
  return goals.map((goal) => {
    const isKc = goal.kind === 'kc';
    const current = (isKc ? ctx.kc : ctx.xp).get(goal.target) ?? null;
    const gained = (isKc ? ctx.killsGained : ctx.xpGained).get(goal.target) ?? 0;
    const perDay = ctx.days > 0 && current !== null ? gained / ctx.days : null;
    if (current === null) {
      return { ...goal, current: null, progress: null, remaining: null, perDay, etaDays: null };
    }
    const targetAmount = goal.kind === 'level' ? xpForLevel(goal.value) : goal.value;
    const remaining = Math.max(0, targetAmount - current);
    return {
      ...goal,
      current: goal.kind === 'level' ? levelForXp(current) : current,
      progress: targetAmount > 0 ? Math.min(1, current / targetAmount) : 1,
      remaining,
      perDay,
      etaDays: remaining === 0 ? 0 : perDay !== null && perDay > 0 ? remaining / perDay : null,
    };
  });
}

export interface GoalInput {
  kind: GoalKind;
  target: string;
  value: number;
}

/**
 * Sets a goal on an account the viewer owns; a goal of the same kind and target is replaced.
 * not_found when the account isn't visible, forbidden for anyone but the owner, invalid for an
 * unknown skill or a value out of range, limit past MAX_GOALS.
 */
export async function setGoal(
  db: DbOrTx,
  viewer: Viewer,
  publicId: string,
  input: GoalInput,
): Promise<GoalRow> {
  const entry = await ownedAccount(db, viewer, publicId);
  await validateGoal(db, input);
  const [existing] = await db
    .select({ n: count() })
    .from(accountGoals)
    .where(eq(accountGoals.accountId, entry.account.id));
  const [same] = await db
    .select({ id: accountGoals.id })
    .from(accountGoals)
    .where(
      and(
        eq(accountGoals.accountId, entry.account.id),
        eq(accountGoals.kind, input.kind),
        eq(accountGoals.target, input.target),
      ),
    );
  if (!same && (existing?.n ?? 0) >= MAX_GOALS) {
    throw new GoalError('limit', `An account can have at most ${MAX_GOALS} goals.`);
  }
  const [row] = await db
    .insert(accountGoals)
    .values({
      accountId: entry.account.id,
      kind: input.kind,
      target: input.target,
      value: input.value,
      createdBy: viewer.userId,
    })
    .onConflictDoUpdate({
      target: [accountGoals.accountId, accountGoals.kind, accountGoals.target],
      set: { value: input.value, createdBy: viewer.userId, createdAt: new Date() },
    })
    .returning();
  if (!row) throw new Error('setGoal: no row');
  return {
    id: row.id,
    kind: row.kind,
    target: row.target,
    value: Number(row.value),
    createdAt: row.createdAt.toISOString(),
  };
}

/** Removes a goal of an account the viewer owns; false when there was no such goal. */
export async function deleteGoal(
  db: DbOrTx,
  viewer: Viewer,
  publicId: string,
  goalId: string,
): Promise<boolean> {
  const entry = await ownedAccount(db, viewer, publicId);
  if (!/^[0-9a-f-]{36}$/i.test(goalId)) return false;
  const deleted = await db
    .delete(accountGoals)
    .where(and(eq(accountGoals.id, goalId), eq(accountGoals.accountId, entry.account.id)))
    .returning({ id: accountGoals.id });
  return deleted.length > 0;
}

async function ownedAccount(
  db: DbOrTx,
  viewer: Principal,
  publicId: string,
): Promise<AccountWithAccess> {
  const entry = await loadVisibleAccount(db, viewer, publicId);
  if (!entry) throw new GoalError('not_found', 'Account not found.');
  if (entry.access.relation !== 'owner') {
    throw new GoalError('forbidden', "Only the account's owner sets its goals.");
  }
  return entry;
}

const NAME_RE = /^[\p{L}\p{N} '’().:&+-]{1,64}$/u;

async function validateGoal(db: DbOrTx, input: GoalInput): Promise<void> {
  if (!(GOAL_KINDS as readonly string[]).includes(input.kind)) {
    throw new GoalError('invalid', 'Unknown goal kind.');
  }
  if (!Number.isSafeInteger(input.value) || input.value < 1) {
    throw new GoalError('invalid', 'The target must be a whole number above 0.');
  }
  if (!NAME_RE.test(input.target)) throw new GoalError('invalid', 'Unknown target.');
  if (input.kind === 'kc') {
    if (input.value > MAX_KC_GOAL) throw new GoalError('invalid', 'That kill count is too high.');
    return;
  }
  const [skill] = await db
    .select({ name: skillsTable.name })
    .from(skillsTable)
    .where(eq(skillsTable.name, input.target));
  if (!skill || skill.name === OVERALL) throw new GoalError('invalid', 'Unknown skill.');
  if (input.kind === 'level' && (input.value < 2 || input.value > MAX_VIRTUAL_LEVEL)) {
    throw new GoalError('invalid', `A level goal is a level from 2 to ${MAX_VIRTUAL_LEVEL}.`);
  }
  if (input.kind === 'xp' && input.value > MAX_SKILL_XP) {
    throw new GoalError('invalid', 'A skill stops at 200M XP.');
  }
}
