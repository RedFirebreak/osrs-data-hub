'use client';
/**
 * "Edit" for an active service key on Admin → Integrations (D-111): its name, the categories it reads
 * and its rate limit, in a dialog filled from the key as it is; PATCH
 * /api/app/admin/service-keys/[id]. The key itself (and its expiry) stays the same, so the
 * integration keeps its configuration and reads what the key reads now from its next request on:
 * this is how the live map gets a category added after its key was made.
 *
 * The state is useEditKeyDialog's; the fields are the create dialog's
 * (components/api-keys/key-dialog-parts.tsx).
 */
import { PencilIcon } from 'lucide-react';
import { useId } from 'react';
import { adminFailure, adminServiceKeyPath } from '@/components/admin/admin-model';
import {
  KeyCategoriesField,
  KeyDialog,
  KeyFormFooter,
  KeyTextField,
} from '@/components/api-keys/key-dialog-parts';
import { useEditKeyDialog } from '@/components/api-keys/use-edit-key-dialog';
import { Button } from '@/components/ui/button';
import { DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { FailureOptions } from '@/lib/api-client';
import {
  EDIT_SERVICE_KEY_FIELDS,
  editServiceFormOf,
  editServiceKeyBody,
  validateServiceKeyForm,
  type ServiceKeyForm,
} from './service-key-model';

export interface EditServiceKeyDialogProps {
  apiKey: {
    id: string;
    name: string;
    categories: ServiceKeyForm['categories'];
    rateLimitPerMinute: number;
  };
  /** Longest key name (API_KEY_NAME_MAX). */
  nameMax: number;
  /** The default requests per minute of a service key (SERVICE_KEY_RATE_LIMIT). */
  rateLimitDefault: number;
  /** The highest rate limit an admin may set (MAX_KEY_RATE_LIMIT). */
  rateLimitMax: number;
}

const EDIT_FAILURE: FailureOptions = {
  ...adminFailure("Couldn't save the key. Try again in a moment."),
  conflict: 'Only an active key can be changed.',
  refreshOnNotFound: true,
};

export function EditServiceKeyDialog({
  apiKey,
  nameMax,
  rateLimitDefault,
  rateLimitMax,
}: EditServiceKeyDialogProps) {
  const id = useId();
  const dialog = useEditKeyDialog({
    initialForm: () => editServiceFormOf(apiKey, rateLimitDefault),
    validate: (form) => validateServiceKeyForm(form, { nameMax, rateLimitMax }),
    fields: EDIT_SERVICE_KEY_FIELDS,
    path: adminServiceKeyPath(apiKey.id),
    body: editServiceKeyBody,
    failure: EDIT_FAILURE,
    savedToast: 'Integration key saved',
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
            Change what the key reads. The key stays the same: the integration keeps its
            configuration and sees the difference from its next request on.
          </DialogDescription>
        </DialogHeader>

        <KeyTextField
          id={`${id}-name`}
          label="Name"
          value={form.name}
          onChange={(name) => update({ name })}
          error={errors.name}
          hint={`The service that uses it. At most ${nameMax} characters.`}
        />
        <KeyCategoriesField
          id={`${id}-cat`}
          value={form.categories}
          onChange={(categories) => update({ categories })}
          error={errors.categories}
        />
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
              Blank: {rateLimitDefault}. At most {rateLimitMax}. <code>/snapshot</code> stays at 1
              per second.
            </>
          }
        />

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
