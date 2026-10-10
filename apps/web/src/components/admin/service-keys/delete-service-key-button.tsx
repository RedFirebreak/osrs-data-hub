'use client';
/**
 * "Delete" for a revoked or expired service key on Admin → Integrations (D-111): POST
 * /api/app/admin/service-keys/[id]/delete behind a confirmation. The key leaves the page; the audit
 * log keeps its history.
 */
import { Trash2Icon } from 'lucide-react';
import { toast } from 'sonner';
import { adminFailure, adminServiceKeyPath } from '@/components/admin/admin-model';
import { ConfirmAction } from '@/components/common/confirm-action';

export interface DeleteServiceKeyButtonProps {
  keyId: string;
  name: string;
}

export function DeleteServiceKeyButton({ keyId, name }: DeleteServiceKeyButtonProps) {
  return (
    <ConfirmAction
      srSuffix={name}
      title={`Delete ${name}?`}
      description="The key is removed from this page; the audit log keeps its history. It no longer works either way."
      confirmLabel="Delete key"
      request={{ path: `${adminServiceKeyPath(keyId)}/delete`, method: 'POST' }}
      failure={{
        ...adminFailure("Couldn't delete the key. Try again in a moment."),
        conflict: 'Revoke the key before deleting it.',
        refreshOnNotFound: true,
      }}
      onDone={() => toast.success(`${name} deleted`)}
    >
      <Trash2Icon aria-hidden data-icon="inline-start" />
      Delete
    </ConfirmAction>
  );
}
