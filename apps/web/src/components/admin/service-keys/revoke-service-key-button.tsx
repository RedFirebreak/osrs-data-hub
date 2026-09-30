'use client';
/**
 * "Revoke" for a service key on Admin → Integrations (D-87): DELETE /api/app/admin/service-keys/[id]
 * behind a confirmation. The integration using it gets 401 from its next request on.
 */
import { BanIcon } from 'lucide-react';
import { toast } from 'sonner';
import { adminServiceKeyPath } from '@/components/admin/admin-model';
import { ConfirmAction } from '@/components/admin/confirm-action';

export interface RevokeServiceKeyButtonProps {
  keyId: string;
  name: string;
}

export function RevokeServiceKeyButton({ keyId, name }: RevokeServiceKeyButtonProps) {
  return (
    <ConfirmAction
      variant="destructive"
      srSuffix={name}
      title={`Revoke ${name}?`}
      description={
        <>
          <p>
            The integration using this key loses access right away: its requests are answered 401.
          </p>
          <p>This can&apos;t be undone; create a new key to give it access again.</p>
        </>
      }
      confirmLabel="Revoke key"
      request={{ path: adminServiceKeyPath(keyId), method: 'DELETE' }}
      failure="Couldn't revoke the key. Try again in a moment."
      onDone={() =>
        toast.success(`${name} revoked`, {
          description: 'The integration using it gets 401 from now on.',
        })
      }
    >
      <BanIcon aria-hidden data-icon="inline-start" />
      Revoke
    </ConfirmAction>
  );
}
