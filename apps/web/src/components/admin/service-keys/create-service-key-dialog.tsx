'use client';
/**
 * "Create integration key" on Admin → Integrations (D-88): a dialog with the key's name, the
 * categories it may read (nothing preselected), its rate limit (blank = the service default) and its
 * expiry; POST /api/app/admin/service-keys. On success the dialog shows the key once, read-only with
 * a Copy button and a clear warning, and can only be left with "Done", which reloads the list. The
 * hub keeps only a hash: the key can't be shown again. After a creation the focus goes to the list's
 * heading (`listHeadingId`) or the page's h1, since the reload re-renders the trigger's surroundings.
 *
 * This file is the service key's own fields and texts; the state (submit, field errors from the
 * server's 400 `details`, focus) is useCreateKeyDialog's and the pieces shared with the user key
 * dialog are in components/api-keys/key-dialog-parts.tsx.
 */
import { PlusIcon } from 'lucide-react';
import { useId } from 'react';
import { adminFailure } from '@/components/admin/admin-model';
import {
  CreatedKeyView,
  KeyCategoriesField,
  KeyDialog,
  KeyExpiryField,
  KeyFormFooter,
  KeyTextField,
} from '@/components/api-keys/key-dialog-parts';
import { useCreateKeyDialog } from '@/components/api-keys/use-create-key-dialog';
import { Button } from '@/components/ui/button';
import { DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  SERVICE_KEY_FIELDS,
  emptyServiceKeyForm,
  serviceKeyBody,
  validateServiceKeyForm,
} from './service-key-model';

export interface CreateServiceKeyDialogProps {
  /** Longest key name (API_KEY_NAME_MAX). */
  nameMax: number;
  /** The default requests per minute of a service key (SERVICE_KEY_RATE_LIMIT). */
  rateLimitDefault: number;
  /** The highest rate limit an admin may set (MAX_KEY_RATE_LIMIT). */
  rateLimitMax: number;
  /** Absolute base URL of the API (APP_URL + /api/v1), for the "try it" line. */
  apiBase: string;
  /** Bigger trigger for the empty state. */
  size?: 'default' | 'lg';
  /** Id of the heading of the list the new key shows up in: it gets the focus after "Done". */
  listHeadingId?: string;
}

const CREATE_FAILURE = adminFailure("Couldn't create the key. Try again in a moment.");

export function CreateServiceKeyDialog({
  nameMax,
  rateLimitDefault,
  rateLimitMax,
  apiBase,
  size = 'default',
  listHeadingId,
}: CreateServiceKeyDialogProps) {
  const id = useId();
  const dialog = useCreateKeyDialog({
    emptyForm: emptyServiceKeyForm,
    validate: (form) => validateServiceKeyForm(form, { nameMax, rateLimitMax }),
    fields: SERVICE_KEY_FIELDS,
    path: '/api/app/admin/service-keys',
    body: serviceKeyBody,
    failure: CREATE_FAILURE,
    createdToast: 'Integration key created',
    listHeadingId,
  });
  const { form, errors, update, created } = dialog;

  return (
    <KeyDialog
      dialog={dialog}
      trigger={
        <Button type="button" size={size}>
          <PlusIcon aria-hidden data-icon="inline-start" />
          Create integration key
        </Button>
      }
    >
      {created ? (
        <CreatedKeyView
          id={`${id}-key`}
          created={created}
          title="Copy the new key"
          description={`${created.name}: paste it into the integration's configuration.`}
          warning="The hub stores only a fingerprint of it. Copy it now and keep it in the integration's secrets. If it leaks, revoke it and create a new one."
          label="Integration key"
          copyWhat="integration key"
          apiBase={apiBase}
          onDone={dialog.close}
        />
      ) : (
        <form onSubmit={dialog.submit} noValidate className="flex flex-col gap-5">
          <DialogHeader>
            <DialogTitle>Create an integration key</DialogTitle>
            <DialogDescription>
              For the guild&apos;s own services, such as its live map. The key belongs to nobody and
              reads exactly what every guild member can see: the accounts and categories shared with
              the guild.
            </DialogDescription>
          </DialogHeader>

          <KeyTextField
            id={`${id}-name`}
            label="Name"
            value={form.name}
            onChange={(name) => update({ name })}
            placeholder="Guild live map"
            error={errors.name}
            hint={`The service that will use it. At most ${nameMax} characters.`}
          />
          <KeyCategoriesField
            id={`${id}-cat`}
            value={form.categories}
            onChange={(categories) => update({ categories })}
            error={errors.categories}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <KeyTextField
              id={`${id}-rate`}
              label="Requests per minute"
              inputMode="numeric"
              value={form.rateLimit}
              onChange={(rateLimit) => update({ rateLimit })}
              placeholder={String(rateLimitDefault)}
              error={errors.rateLimitPerMinute}
              hint={
                <>
                  Blank: {rateLimitDefault}. At most {rateLimitMax}. <code>/snapshot</code> stays at
                  1 per second.
                </>
              }
            />
            <KeyExpiryField
              id={`${id}-expiry`}
              value={form.expiry}
              onChange={(expiry) => update({ expiry })}
              error={errors.expiresInDays}
            />
          </div>

          <p className="text-xs text-muted-foreground">
            Access follows the owners&apos; sharing settings on every request. Offboarding anyone,
            you included, never revokes an integration key: revoke it here.
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
