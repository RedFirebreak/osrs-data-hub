/**
 * Friends (D-117): a member invites friends who are not in the Discord guild by their Discord
 * username (InviteFriendForm → POST /api/app/friends), up to the admin's number per member, and
 * removes them again (RemoveFriendButton). Invited friends see who invited them instead: friends
 * can't invite. While an admin has invites turned off the list stays, without the form.
 */
import { getConfig } from '@hub/core';
import { getDb } from '@hub/db';
import { getMyFriends, type MyFriend } from '@hub/server';
import { HeartHandshakeIcon } from 'lucide-react';
import type { Metadata } from 'next';
import { InviteFriendForm } from '@/components/friends/invite-friend-form';
import { placesLeft } from '@/components/friends/friends-model';
import { RemoveFriendButton } from '@/components/friends/remove-friend-button';
import { UserAvatar } from '@/components/common/user-avatar';
import { PageHeader } from '@/components/shell/page-header';
import { RelativeTime } from '@/components/time/relative-time';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { requireUser } from '@/lib/session';

export function generateMetadata(): Metadata {
  return { title: `Friends · ${getConfig().hubName}` };
}

export default async function FriendsPage() {
  const { user } = await requireUser();
  const config = getConfig();
  const guild = config.discord.guildName;
  const view = await getMyFriends(getDb().db, user.id);
  const now = new Date().toISOString();

  if (view.access === 'friend') {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
        <PageHeader title="Friends" />
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>You&apos;re here as a friend</h2>
            </CardTitle>
            <CardDescription>
              {view.invitedBy
                ? `${view.invitedBy} invited you to this hub.`
                : 'A member invited you to this hub.'}{' '}
              Only members of {guild} can invite friends. Join {guild} on Discord and you count as a
              member from your next sign-in.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  const used = view.friends.length;
  const full = used >= view.maxPerMember;
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <PageHeader
        title="Friends"
        description={`Bring friends who aren't in ${guild}. They sign in with Discord, just like you.`}
      />

      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Invite a friend</h2>
          </CardTitle>
          <CardDescription>
            Your friend sees the hub as you do and can connect their own RuneLite. If you leave{' '}
            {guild}, your friends lose access too.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {view.enabled ? (
            <>
              <InviteFriendForm hubOrigin={config.appOrigin} disabled={full} />
              <p className="text-sm text-muted-foreground">
                {placesLeft(used, view.maxPerMember)}
                {full && '. Remove a friend to invite someone else.'}
              </p>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              An admin has turned off inviting friends on this hub. Friends you invited before keep
              their access.
            </p>
          )}
        </CardContent>
      </Card>

      <section aria-labelledby="your-friends" className="flex flex-col gap-3">
        <h2 id="your-friends" className="text-lg font-semibold">
          Your friends{' '}
          <span className="font-normal text-muted-foreground">
            ({used} of {view.maxPerMember})
          </span>
        </h2>
        {used === 0 ? (
          <Card className="items-center px-4 py-10 text-center">
            <span
              aria-hidden
              className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground"
            >
              <HeartHandshakeIcon className="size-6" />
            </span>
            <p className="text-sm text-muted-foreground">No friends invited yet.</p>
          </Card>
        ) : (
          <ul className="flex flex-col divide-y rounded-xl ring-1 ring-foreground/10">
            {view.friends.map((f) => (
              <FriendRow key={f.id} friend={f} now={now} graceDays={config.offboardGraceDays} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function FriendRow({
  friend,
  now,
  graceDays,
}: {
  friend: MyFriend;
  now: string;
  graceDays: number;
}) {
  const signedIn = friend.friend !== null;
  return (
    <li className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-center gap-3">
        <UserAvatar
          name={friend.friend?.name ?? friend.username}
          image={friend.friend?.image ?? null}
          size="default"
        />
        <div className="flex min-w-0 flex-col">
          <span className="flex flex-wrap items-center gap-1.5 font-medium">
            <span className="truncate">{friend.friend?.name ?? friend.username}</span>
            {!signedIn ? (
              <Badge variant="outline">Not signed in yet</Badge>
            ) : friend.friend?.status === 'grace' ? (
              <Badge variant="outline">No access</Badge>
            ) : null}
          </span>
          <span className="text-sm text-muted-foreground">
            <span className="font-mono">@{friend.username}</span>
            {' · '}
            {friend.joinedAt ? (
              <RelativeTime date={friend.joinedAt} now={now} prefix="joined" />
            ) : (
              <RelativeTime date={friend.createdAt} now={now} prefix="invited" />
            )}
          </span>
        </div>
      </div>
      <div className="flex shrink-0 justify-end">
        <RemoveFriendButton
          inviteId={friend.id}
          username={friend.username}
          signedIn={signedIn && friend.friend?.status === 'active'}
          graceDays={graceDays}
        />
      </div>
    </li>
  );
}
