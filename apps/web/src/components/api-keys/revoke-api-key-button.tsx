'use client';
/**
 * "Revoke" for one API key, behind a confirmation dialog (D-76, ConfirmAction): DELETE
 * /api/app/api-keys/[id]. The next request with the key gets 401. The dialog stays open (and says
 * why) when the request fails. After a revoke the key moves to "Revoked and expired keys", taking
 * this button with it: the focus goes to the heading of the section it was in, not to <body>. A key
 * that was already revoked elsewhere (404) leaves the list as well (REVOKE_KEY_FAILURE).
 */
import { BanIcon } from 'lucide-react';
import { toast } from 'sonner';
import { ConfirmAction } from '@/components/admin/confirm-action';
import { REVOKE_KEY_FAILURE, apiKeyPath } from './api-key-model';

export interface RevokeApiKeyButtonProps {
  keyId: string;
  name: string;
}

export function RevokeApiKeyButton({ keyId, name }: RevokeApiKeyButtonProps) {
  return (
    <ConfirmAction
      variant="destructive"
      srSuffix={name}
      title={`Revoke ${name}?`}
      description="Every app using this key loses access right away: its requests are answered 401. This can't be undone; create a new key to give an app access again."
      confirmLabel="Revoke key"
      request={{ path: apiKeyPath(keyId), method: 'DELETE' }}
      failure={REVOKE_KEY_FAILURE}
      onDone={() =>
        toast.success(`${name} revoked`, {
          description: 'Apps using this key get 401 from now on.',
        })
      }
    >
      <BanIcon aria-hidden data-icon="inline-start" />
      Revoke
    </ConfirmAction>
  );
}
