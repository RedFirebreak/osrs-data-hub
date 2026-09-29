/**
 * Admin → Users (handoff §12, §14): every user from listUsers — avatar, name, Discord id, admin
 * role, status (grace: how long is left and why), the last Discord re-verification with consecutive
 * failures highlighted (D-34: errors never offboard, so a run of failures needs a human), active
 * devices and linked accounts — with Offboard (reason 'admin', D-35) and Restore.
 */
import { getConfig } from '@hub/core';
import { getDb } from '@hub/db';
import { listUsers, type AdminUserRow } from '@hub/server';
import { CircleAlertIcon, UsersIcon } from 'lucide-react';
import type { Metadata } from 'next';
import { graceDaysLeft, offboardReasonLabel, pluralDays } from '@/components/admin/admin-model';
import { AdminEmptyState, AdminSectionHeader, StatTiles } from '@/components/admin/admin-section';
import { AdminRoleBadge, UserStatusBadge } from '@/components/admin/badges';
import { DateTime } from '@/components/admin/date-time';
import { UserActions } from '@/components/admin/user-actions';
import { UserAvatar } from '@/components/account/user-avatar';
import { RelativeTime } from '@/components/events/relative-time';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { requireAdmin } from '@/lib/session';
import { cn } from '@/lib/utils';

export function generateMetadata(): Metadata {
  return { title: `Users · Admin · ${getConfig().hubName}` };
}

export default async function AdminUsersPage() {
  const { user: me } = await requireAdmin();
  const users = await listUsers(getDb().db);
  const { offboardGraceDays } = getConfig();
  const now = new Date();
  const inGrace = users.filter((u) => u.status === 'grace').length;
  const failing = users.filter((u) => u.verifyFailures > 0).length;

  return (
    <section aria-labelledby="admin-users" className="flex flex-col gap-4">
      <AdminSectionHeader
        id="admin-users"
        title="Users"
        description={`Everyone who signed in with Discord. Offboarded users keep their data for ${pluralDays(offboardGraceDays)}, then it is deleted.`}
      />
      <StatTiles
        label="User totals"
        stats={[
          { label: 'Users', value: String(users.length) },
          { label: 'Active', value: String(users.length - inGrace) },
          { label: 'In grace', value: String(inGrace), attention: inGrace > 0 },
          {
            label: 'Failing Discord checks',
            value: String(failing),
            attention: failing > 0,
            hint: failing > 0 ? 'Check the bot token and the guild' : undefined,
          },
        ]}
      />
      {users.length === 0 ? (
        <AdminEmptyState icon={UsersIcon} title="No users yet">
          Members appear here after they sign in with Discord.
        </AdminEmptyState>
      ) : (
        <div className="rounded-xl ring-1 ring-foreground/10">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">User</TableHead>
                <TableHead className="hidden sm:table-cell">Status</TableHead>
                <TableHead className="hidden md:table-cell">Discord check</TableHead>
                <TableHead className="hidden text-right sm:table-cell">Devices</TableHead>
                <TableHead className="hidden text-right sm:table-cell">Accounts</TableHead>
                <TableHead className="pr-4 text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map((u) => (
                <UserRow
                  key={u.id}
                  user={u}
                  isSelf={u.id === me.id}
                  now={now}
                  graceDays={offboardGraceDays}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}

function UserRow({
  user,
  isSelf,
  now,
  graceDays,
}: {
  user: AdminUserRow;
  isSelf: boolean;
  now: Date;
  graceDays: number;
}) {
  const daysLeft = graceDaysLeft(user.graceUntil, now);
  const status = (
    <div className="flex flex-col items-start gap-1">
      <UserStatusBadge status={user.status} />
      {user.status === 'grace' && (
        <span className="text-xs whitespace-normal text-muted-foreground">
          {offboardReasonLabel(user.offboardReason)}
          {user.graceUntil && (
            <>
              {' · '}
              {daysLeft === 0 ? 'deleted soon' : `${pluralDays(daysLeft ?? 0)} left`} (until{' '}
              <DateTime date={user.graceUntil.toISOString()} />)
            </>
          )}
        </span>
      )}
    </div>
  );
  return (
    <TableRow className={cn(user.verifyFailures > 0 && 'bg-amber-500/5')}>
      <TableCell className="pl-4">
        <div className="flex min-w-0 items-center gap-3">
          <UserAvatar name={user.name} image={user.image} size="default" />
          <div className="flex min-w-0 flex-col">
            <span className="flex flex-wrap items-center gap-1.5 font-medium">
              {user.name}
              {user.isAdmin && <AdminRoleBadge />}
              {isSelf && <Badge variant="outline">You</Badge>}
            </span>
            <span className="font-mono text-xs text-muted-foreground">
              {user.discordId ?? 'no Discord id'}
            </span>
            <span className="text-xs text-muted-foreground sm:hidden">
              {user.devices} {user.devices === 1 ? 'device' : 'devices'} · {user.accounts}{' '}
              {user.accounts === 1 ? 'account' : 'accounts'}
            </span>
            {/* On phones the Status column is folded in here, so the row fits without scrolling. */}
            <div className="mt-1 sm:hidden">{status}</div>
            {user.verifyFailures > 0 && (
              // The "Discord check" column is hidden on narrow screens; the row tint alone is colour.
              <VerifyFailuresBadge failures={user.verifyFailures} className="mt-1 md:hidden" />
            )}
          </div>
        </div>
      </TableCell>
      <TableCell className="hidden sm:table-cell">{status}</TableCell>
      <TableCell className="hidden md:table-cell">
        <div className="flex flex-col items-start gap-1">
          {user.lastVerifiedAt ? (
            <RelativeTime
              date={user.lastVerifiedAt.toISOString()}
              now={now.toISOString()}
              prefix="Verified"
              className="text-sm"
            />
          ) : (
            <span className="text-sm text-muted-foreground">Not checked yet</span>
          )}
          {user.verifyFailures > 0 && <VerifyFailuresBadge failures={user.verifyFailures} />}
        </div>
      </TableCell>
      <TableCell className="hidden text-right tabular-nums sm:table-cell">{user.devices}</TableCell>
      <TableCell className="hidden text-right tabular-nums sm:table-cell">
        {user.accounts}
      </TableCell>
      <TableCell className="pr-4 text-right">
        <UserActions
          userId={user.id}
          name={user.name}
          status={user.status}
          offboardReason={user.offboardReason}
          isSelf={isSelf}
          graceDays={graceDays}
        />
      </TableCell>
    </TableRow>
  );
}

/** Consecutive failed Discord re-verifications (D-34: errors never offboard, a human must look). */
function VerifyFailuresBadge({ failures, className }: { failures: number; className?: string }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        'border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300',
        className,
      )}
    >
      <CircleAlertIcon aria-hidden data-icon="inline-start" />
      {failures} failed {failures === 1 ? 'Discord check' : 'Discord checks'} in a row
    </Badge>
  );
}
