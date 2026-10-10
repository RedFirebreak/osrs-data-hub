'use client';
/**
 * "Delete" for one of the user's revoked or expired keys (D-111), behind a confirmation
 * (ConfirmAction): POST /api/app/api-keys/[id]/delete. The key leaves the page; it could never be
 * used again anyway. A key deleted elsewhere (404) leaves the list as well.
 */
import { Trash2Icon } from 'lucide-react';
import { toast } from 'sonner';
import { ConfirmAction } from '@/components/common/confirm-action';
import { DELETE_KEY_FAILURE, apiKeyPath } from './api-key-model';

export interface DeleteApiKeyButtonProps {
  keyId: string;
  name: string;
}

export function DeleteApiKeyButton({ keyId, name }: DeleteApiKeyButtonProps) {
  return (
    <ConfirmAction
      srSuffix={name}
      title={`Delete ${name}?`}
      description="The key is removed from this page. It no longer works either way; nothing changes for the apps that had it."
      confirmLabel="Delete key"
      request={{ path: `${apiKeyPath(keyId)}/delete`, method: 'POST' }}
      failure={DELETE_KEY_FAILURE}
      onDone={() => toast.success(`${name} deleted`)}
    >
      <Trash2Icon aria-hidden data-icon="inline-start" />
      Delete
    </ConfirmAction>
  );
}
