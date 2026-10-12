/**
 * Admin → Friends (D-117): every invite members handed out (the friend, who invited them, whether
 * they signed in) with Blacklist, and the blacklist itself: the Discord usernames nobody may invite,
 * with Remove, and a field to bar a name nobody invited yet. Whether members may invite at all, and
 * how many each, is on Admin → Settings.
 */
import { getConfig } from '@hub/core';
import { getDb } from '@hub/db';
import {
  getInviteFriends,
  listFriendBlacklist,
  listFriendInvites,
  type AdminFriendInvite,
} from '@hub/server';
import { HeartHandshakeIcon } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { AdminEmptyState, AdminSectionHeader, StatTiles } from '@/components/admin/admin-section';
import { UserStatusBadge } from '@/components/admin/badges';
import { DateTime } from '@/components/admin/date-time';
import { BlacklistFriendButton } from '@/components/admin/friends/blacklist-friend-button';
import { BlacklistUsernameForm } from '@/components/admin/friends/blacklist-username-form';
import { UnblacklistButton } from '@/components/admin/friends/unblacklist-button';
import { UserAvatar } from '@/components/common/user-avatar';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { adminMetadata, requireAdmin } from '@/lib/session';

export function generateMetadata(): Promise<Metadata> {
  return adminMetadata('Friends');
}

export default async function AdminFriendsPage() {
  await requireAdmin();
  const { db } = getDb();
  const [invites, blacklist, settings] = await Promise.all([
    listFriendInvites(db),
    listFriendBlacklist(db),
    getInviteFriends(db),
  ]);
  const { offboardGraceDays, discord } = getConfig();
  const signedIn = invites.filter((i) => i.friend?.status === 'active').length;

  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby="admin-friends" className="flex flex-col gap-4">
        <AdminSectionHeader
          id="admin-friends"
          title="Friends"
          description={
            <>
              People members of {discord.guildName} invited by their Discord username. A friend gets
              in although they aren&apos;t in {discord.guildName}, and loses access when the member
              who invited them leaves. Inviting is{' '}
              {settings.enabled
                ? `on, ${settings.maxPerMember} per member`
                : 'off: friends already in keep their access'}{' '}
              (
              <Link href="/admin/settings" className="underline underline-offset-4">
                Settings
              </Link>
              ).
            </>
          }
        />
        <StatTiles
          label="Friend totals"
          stats={[
            { label: 'Invites', value: String(invites.length) },
            { label: 'Signed in', value: String(signedIn) },
            {
              label: 'Not signed in yet',
              value: String(invites.filter((i) => i.friend === null).length),
            },
            { label: 'Blacklisted', value: String(blacklist.length) },
          ]}
        />
        {invites.length === 0 ? (
          <AdminEmptyState icon={HeartHandshakeIcon} title="No friends invited yet">
            Members invite friends on their Friends page, in the avatar menu.
          </AdminEmptyState>
        ) : (
          <div className="rounded-xl ring-1 ring-foreground/10">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Friend</TableHead>
                  <TableHead className="hidden sm:table-cell">Invited by</TableHead>
                  <TableHead className="hidden md:table-cell">Invited</TableHead>
                  <TableHead className="pr-4 text-right">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {invites.map((invite) => (
                  <InviteRow key={invite.id} invite={invite} graceDays={offboardGraceDays} />
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      <section aria-labelledby="admin-friend-blacklist" className="flex flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle>
              <h2 id="admin-friend-blacklist">Blacklist</h2>
            </CardTitle>
            <CardDescription>
              Discord usernames nobody can invite. A blacklisted friend who had signed in is barred
              by their Discord account, so a new username doesn&apos;t get them back in. Someone who
              is in {discord.guildName} still signs in as a member.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-6">
            <BlacklistUsernameForm />
            {blacklist.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nobody is blacklisted.</p>
            ) : (
              <ul className="flex flex-col divide-y rounded-xl ring-1 ring-foreground/10">
                {blacklist.map((entry) => (
                  <li
                    key={entry.username}
                    className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="flex min-w-0 flex-col">
                      <span className="flex flex-wrap items-center gap-1.5 font-mono text-sm">
                        @{entry.username}
                        {entry.account && <Badge variant="outline">Discord account too</Badge>}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        <DateTime date={entry.createdAt.toISOString()} />
                        {entry.createdBy && ` by ${entry.createdBy}`}
                      </span>
                    </div>
                    <div className="flex justify-end">
                      <UnblacklistButton username={entry.username} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}

function InviteRow({ invite, graceDays }: { invite: AdminFriendInvite; graceDays: number }) {
  const friend = invite.friend;
  return (
    <TableRow>
      <TableCell className="pl-4">
        <div className="flex min-w-0 items-center gap-3">
          <UserAvatar name={friend?.name ?? invite.username} image={friend?.image ?? null} />
          <div className="flex min-w-0 flex-col">
            <span className="flex flex-wrap items-center gap-1.5 font-medium">
              {friend?.name ?? invite.username}
              {friend ? (
                <UserStatusBadge status={friend.status} />
              ) : (
                <Badge variant="outline">Not signed in yet</Badge>
              )}
            </span>
            <span className="font-mono text-xs text-muted-foreground">@{invite.username}</span>
            <span className="text-xs text-muted-foreground sm:hidden">
              Invited by {invite.invitedBy.name}
            </span>
          </div>
        </div>
      </TableCell>
      <TableCell className="hidden sm:table-cell">
        <div className="flex items-center gap-2">
          <UserAvatar name={invite.invitedBy.name} image={invite.invitedBy.image} />
          <span className="truncate">{invite.invitedBy.name}</span>
          {invite.invitedBy.status === 'grace' && <UserStatusBadge status="grace" />}
        </div>
      </TableCell>
      <TableCell className="hidden md:table-cell">
        <div className="flex flex-col text-sm">
          <DateTime date={invite.createdAt.toISOString()} />
          {invite.joinedAt && (
            <span className="text-xs text-muted-foreground">
              Signed in <DateTime date={invite.joinedAt.toISOString()} />
            </span>
          )}
        </div>
      </TableCell>
      <TableCell className="pr-4 text-right">
        <BlacklistFriendButton
          username={invite.username}
          invitedBy={invite.invitedBy.name}
          signedIn={friend?.status === 'active'}
          graceDays={graceDays}
        />
      </TableCell>
    </TableRow>
  );
}
