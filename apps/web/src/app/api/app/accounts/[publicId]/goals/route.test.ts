/**
 * POST /api/app/accounts/[publicId]/goals and DELETE …/goals/[goalId] (D-109): only the owner sets
 * and removes goals, the refusals map to 404/403/400/409, and CSRF and auth are checked.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTestDb, type WebTestContext } from '@/lib/test-utils';
import { accountSeeder, type SeededAccount } from '../../test-seed';
import { DELETE } from './[goalId]/route';
import { POST } from './route';

let ctx: WebTestContext;
let account: SeededAccount;
let owner: string;
let member: string;

beforeAll(async () => {
  ctx = await withTestDb({ label: 'goalroutes' });
  const seed = accountSeeder(ctx.t.db);
  const ownerId = await ctx.seedUser();
  owner = await ctx.signIn(ownerId);
  member = await ctx.signIn(await ctx.seedUser());
  account = await seed.account({ owner: ownerId, name: 'Goal Getter' });
});
afterAll(() => ctx.cleanup());

interface ErrorBody {
  error: { code: string };
}

function post(json: unknown, cookie?: string, publicId = account.publicId, sameOrigin = true) {
  return POST(
    ctx.request(`/api/app/accounts/${publicId}/goals`, {
      method: 'POST',
      cookie,
      json,
      sameOrigin,
    }),
    { params: Promise.resolve({ publicId }) },
  );
}

function del(goalId: string, cookie?: string) {
  const publicId = account.publicId;
  return DELETE(
    ctx.request(`/api/app/accounts/${publicId}/goals/${goalId}`, { method: 'DELETE', cookie }),
    { params: Promise.resolve({ publicId, goalId }) },
  );
}

describe('goal routes', () => {
  it('401 without a session, 403 bad_origin without the Origin', async () => {
    expect((await post({ kind: 'kc', target: 'Zulrah', value: 100 })).status).toBe(401);
    const res = await post({ kind: 'kc', target: 'Zulrah', value: 100 }, owner, undefined, false);
    expect(res.status).toBe(403);
    expect(((await res.json()) as ErrorBody).error.code).toBe('bad_origin');
  });

  it('lets the owner set a goal, replace it and remove it', async () => {
    const res = await post({ kind: 'level', target: 'Attack', value: 99 }, owner);
    expect(res.status).toBe(200);
    const { goal } = (await res.json()) as { goal: { id: string; value: number } };
    expect(goal.value).toBe(99);
    const again = (await (
      await post({ kind: 'level', target: 'Attack', value: 90 }, owner)
    ).json()) as {
      goal: { id: string; value: number };
    };
    expect(again.goal).toMatchObject({ id: goal.id, value: 90 });
    expect((await del(goal.id, owner)).status).toBe(204);
    expect((await del(goal.id, owner)).status).toBe(404);
  });

  it('refuses anyone but the owner, unknown accounts and bad targets', async () => {
    const forbidden = await post({ kind: 'kc', target: 'Zulrah', value: 100 }, member);
    expect(forbidden.status).toBe(403);
    expect((await post({ kind: 'kc', target: 'Zulrah', value: 100 }, owner, 'nope')).status).toBe(
      404,
    );
    const unknown = await post({ kind: 'level', target: 'Overall', value: 99 }, owner);
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as ErrorBody).error.code).toBe('invalid');
    const malformed = await post({ kind: 'level', target: 'Attack', value: 1.5 }, owner);
    expect(((await malformed.json()) as ErrorBody).error.code).toBe('invalid_request');
    const kc = (await (await post({ kind: 'kc', target: 'Zulrah', value: 100 }, owner)).json()) as {
      goal: { id: string };
    };
    expect((await del(kc.goal.id, member)).status).toBe(403);
  });
});
