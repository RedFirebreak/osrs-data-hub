'use client';
/**
 * "Create key" (D-69, D-76): a dialog with the key's name, the categories it may read (nothing
 * preselected: the user chooses), its account scope (every account the user can see, now and later,
 * or picked ones) and its expiry; POST /api/app/api-keys. On success the dialog shows the key once,
 * read-only with a Copy button and a clear warning, and can only be left with "Done", which reloads
 * the list. The hub keeps only a hash: the key can't be shown again. The reload can take the trigger
 * away (the empty state's button, or the header's when the limit is reached), so after a creation
 * the focus goes to the list's heading (`listHeadingId`) or the page's h1.
 *
 * This file is the user key's own fields and texts; the state (submit, field errors from the
 * server's 400 `details`, focus) is useCreateKeyDialog's and the pieces shared with the service key
 * dialog are in key-dialog-parts.tsx. The user's accounts come from the page (the same rule the
 * server checks: what they can see right now, no admin override).
 */
import { PlusIcon } from 'lucide-react';
import { useId } from 'react';
import { Button } from '@/components/ui/button';
import { DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AccountScopeField, type PickableAccount } from './account-scope-field';
import {
  CREATE_KEY_FAILURE,
  CREATE_KEY_FIELDS,
  createKeyBody,
  emptyCreateForm,
  validateCreateForm,
} from './api-key-model';
import {
  CreatedKeyView,
  KeyCategoriesField,
  KeyDialog,
  KeyExpiryField,
  KeyFormFooter,
  KeyTextField,
} from './key-dialog-parts';
import { useCreateKeyDialog } from './use-create-key-dialog';

export type { PickableAccount };

export interface CreateApiKeyDialogProps {
  /** Accounts the user can see right now, sorted by name. */
  accounts: PickableAccount[];
  /** Longest key name (API_KEY_NAME_MAX). */
  nameMax: number;
  /** The user has the most active keys allowed: the trigger is disabled. */
  atLimit: boolean;
  /** Absolute base URL of the API (APP_URL + /api/v1), for the "try it" line. */
  apiBase: string;
  /** Bigger trigger for the empty state. */
  size?: 'default' | 'lg';
  /** Id of the heading of the list the new key shows up in: it gets the focus after "Done". */
  listHeadingId?: string;
}

export function CreateApiKeyDialog({
  accounts,
  nameMax,
  atLimit,
  apiBase,
  size = 'default',
  listHeadingId,
}: CreateApiKeyDialogProps) {
  const id = useId();
  const dialog = useCreateKeyDialog({
    emptyForm: emptyCreateForm,
    validate: (form) => validateCreateForm(form, nameMax),
    fields: CREATE_KEY_FIELDS,
    path: '/api/app/api-keys',
    body: createKeyBody,
    failure: CREATE_KEY_FAILURE,
    createdToast: 'API key created',
    listHeadingId,
  });
  const { form, errors, update, created } = dialog;

  return (
    <KeyDialog
      dialog={dialog}
      trigger={
        <Button type="button" size={size} disabled={atLimit}>
          <PlusIcon aria-hidden data-icon="inline-start" />
          Create key
        </Button>
      }
    >
      {created ? (
        <CreatedKeyView
          id={`${id}-key`}
          created={created}
          title="Copy your new key"
          description={`${created.name}: paste it into the app that will use it.`}
          warning="The hub stores only a fingerprint of it. Copy it now and keep it somewhere safe, like a password. If you lose it, revoke it and create a new one."
          label="API key"
          copyWhat="API key"
          apiBase={apiBase}
          onDone={dialog.close}
        />
      ) : (
        <form onSubmit={dialog.submit} noValidate className="flex flex-col gap-5">
          <DialogHeader>
            <DialogTitle>Create an API key</DialogTitle>
            <DialogDescription>
              A key reads only what you choose here, and never more than you can see yourself.
            </DialogDescription>
          </DialogHeader>

          <KeyTextField
            id={`${id}-name`}
            label="Name"
            value={form.name}
            onChange={(name) => update({ name })}
            placeholder="Home Assistant"
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
          <KeyExpiryField
            id={`${id}-expiry`}
            value={form.expiry}
            onChange={(expiry) => update({ expiry })}
            error={errors.expiresInDays}
            className="sm:max-w-48"
          />

          <p className="text-xs text-muted-foreground">
            Access is checked on every request against the owners&apos; sharing settings: when
            someone stops sharing with you, the key stops seeing it too.
          </p>

          <KeyFormFooter
            error={dialog.formError}
            pending={dialog.pending}
            submitLabel="Create key"
            onCancel={dialog.close}
          />
        </form>
      )}
    </KeyDialog>
  );
}
