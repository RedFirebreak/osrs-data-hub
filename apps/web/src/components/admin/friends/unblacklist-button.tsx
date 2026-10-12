'use client';
/**
 * Admin → Friends: "Remove" for one blacklisted username (D-117), behind a confirmation dialog:
 * DELETE /api/app/admin/friend-blacklist/[username]. The name can be invited again.
 */
import { UndoIcon } from 'lucide-react';
import { toast } from 'sonner';
import { ConfirmAction } from '@/components/common/confirm-action';
import { FRIEND_BLACKLIST_API_PATH, adminFailure } from '../admin-model';

export function UnblacklistButton({ username }: { username: string }) {
  return (
    <ConfirmAction
      srSuffix={username}
      title={`Take ${username} off the blacklist?`}
      description={`Members can invite ${username} again. Someone offboarded for the blacklist stays out until they are invited again and sign in.`}
      confirmLabel="Take off the blacklist"
      request={{
        path: `${FRIEND_BLACKLIST_API_PATH}/${encodeURIComponent(username)}`,
        method: 'DELETE',
      }}
      failure={{
        ...adminFailure(`Couldn't take ${username} off the blacklist. Try again in a moment.`),
        refreshOnNotFound: true,
      }}
      onDone={() => toast.success(`${username} can be invited again`)}
    >
      <UndoIcon aria-hidden data-icon="inline-start" />
      Remove
    </ConfirmAction>
  );
}
