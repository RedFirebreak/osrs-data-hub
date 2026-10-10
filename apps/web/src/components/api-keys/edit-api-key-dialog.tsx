'use client';
/**
 * "Edit" for one of the user's active keys (D-111): its name, the categories it reads and its account
 * scope, in a dialog filled from the key as it is; PATCH /api/app/api-keys/[id]. The key itself (and
 * its expiry) stays the same, so the app using it needs no change and reads what the key reads now
 * from its next request on. A listed account the user can no longer see isn't offered, and the
 * dialog says that saving drops it.
 *
 * The state is useEditKeyDialog's; the fields are the create dialog's (key-dialog-parts.tsx,
 * account-scope-field.tsx). The user's accounts come from the page.
 */
import type { ApiKeyInfo } from '@hub/server';
import { PencilIcon } from 'lucide-react';
import { useId } from 'react';
import { Button } from '@/components/ui/button';
import { DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AccountScopeField, type PickableAccount } from './account-scope-field';
import {
  EDIT_KEY_FAILURE,
  EDIT_KEY_FIELDS,
  apiKeyPath,
  editFormOf,
  editKeyBody,
  validateCreateForm,
  type EditKeyForm,
} from './api-key-model';
import { KeyCategoriesField, KeyDialog, KeyFormFooter, KeyTextField } from './key-dialog-parts';
import { useEditKeyDialog } from './use-edit-key-dialog';

export interface EditApiKeyDialogProps {
  apiKey: Pick<ApiKeyInfo, 'id' | 'name' | 'categories' | 'accountScope' | 'accounts'>;
  /** Accounts the user can see right now, sorted by name. */
  accounts: PickableAccount[];
  /** Longest key name (API_KEY_NAME_MAX). */
  nameMax: number;
}

export function EditApiKeyDialog({ apiKey, accounts, nameMax }: EditApiKeyDialogProps) {
  const id = useId();
  const { hiddenAccounts } = editFormOf(apiKey);
  const dialog = useEditKeyDialog({
    initialForm: (): EditKeyForm => {
      const { hiddenAccounts: _, ...form } = editFormOf(apiKey);
      return form;
    },
    validate: (form) => validateCreateForm(form, nameMax),
    fields: EDIT_KEY_FIELDS,
    path: apiKeyPath(apiKey.id),
    body: editKeyBody,
    failure: EDIT_KEY_FAILURE,
    savedToast: 'API key saved',
  });
  const { form, errors, update } = dialog;

  return (
    <KeyDialog
      dialog={dialog}
      trigger={
        <Button type="button" variant="outline">
          <PencilIcon aria-hidden data-icon="inline-start" />
          Edit
          <span className="sr-only"> {apiKey.name}</span>
        </Button>
      }
    >
      <form onSubmit={dialog.submit} noValidate className="flex flex-col gap-5">
        <DialogHeader>
          <DialogTitle>Edit {apiKey.name}</DialogTitle>
          <DialogDescription>
            Change what the key reads. The key stays the same: the app using it needs no change and
            sees the difference from its next request on.
          </DialogDescription>
        </DialogHeader>

        <KeyTextField
          id={`${id}-name`}
          label="Name"
          value={form.name}
          onChange={(name) => update({ name })}
          error={errors.name}
          hint={`So you can recognise it later. At most ${nameMax} characters.`}
        />
        <KeyCategoriesField
          id={`${id}-cat`}
          value={form.categories}
          onChange={(categories) => update({ categories })}
          error={errors.categories}
        />
        <AccountScopeField
          id={id}
          accounts={accounts}
          scope={form.scope}
          selected={form.accountPublicIds}
          onChange={update}
          error={errors.accountPublicIds}
        />
        {hiddenAccounts > 0 && form.scope === 'list' && (
          <p className="text-xs text-muted-foreground">
            {hiddenAccounts === 1
              ? 'The key also lists an account you can no longer see. Saving removes it.'
              : `The key also lists ${hiddenAccounts} accounts you can no longer see. Saving removes them.`}
          </p>
        )}

        <KeyFormFooter
          error={dialog.formError}
          pending={dialog.pending}
          submitLabel="Save changes"
          onCancel={dialog.close}
        />
      </form>
    </KeyDialog>
  );
}
