import type { MyFriend } from '@hub/server';

/** A friend as the routes send it: dates as ISO strings. */
export interface FriendJson {
  id: string;
  username: string;
  createdAt: string;
  joinedAt: string | null;
  friend: { name: string; image: string | null; status: 'active' | 'grace' } | null;
}

export function friendJson(f: MyFriend): FriendJson {
  return {
    id: f.id,
    username: f.username,
    createdAt: f.createdAt.toISOString(),
    joinedAt: f.joinedAt?.toISOString() ?? null,
    friend: f.friend,
  };
}
