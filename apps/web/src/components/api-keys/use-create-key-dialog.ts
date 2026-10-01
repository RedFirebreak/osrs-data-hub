'use client';
/**
 * The state behind a "create key" dialog, shared by user keys (D-76) and service keys (D-88): the
 * form, its errors, the request and the key that came back. Each dialog brings its own form shape,
 * validation, endpoint and wording, and renders its own fields (key-dialog-parts.tsx has the pieces).
 *
 * - Submit validates on the client first, then POSTs. A 201 with a key switches the dialog to the
 *   "copy your key" view; the server's 400 `details` are shown next to their fields; anything else
 *   goes in the form's error line.
 * - While the request runs the dialog can't be closed. Once the key is shown, it is left only on
 *   purpose ("Done" or the close button, see KeyDialog): the hub keeps a hash, so the key can't be
 *   shown again.
 * - Closing after a creation reloads the list (router.refresh()). That can take the trigger away (an
 *   empty state's button, or a header button once the limit is reached), so the focus goes to the
 *   list's heading (`listHeadingId`) or the page's h1. Every close resets the form.
 */
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import {
  apiErrorDetails,
  failureMessage,
  fieldErrorsFrom,
  type FailureOptions,
} from '@/lib/api-client';
import { mainHeading, useFocusReturn } from '@/lib/focus';
import { useApiRequest } from '@/lib/use-api-request';
import { createdKeyFrom } from './api-key-model';

/** The key the hub just created (shown once) and the name it was given. */
export interface CreatedKey {
  key: string;
  name: string;
}

export interface CreateKeyDialogOptions<F extends { name: string }, K extends string> {
  /** A new, empty form. */
  emptyForm: () => F;
  /** Client-side checks before sending (the server checks everything again). */
  validate: (form: F) => Partial<Record<K, string>>;
  /** The form's fields the server's 400 `details` can name. */
  fields: readonly K[];
  /** Where the key is created (POST). */
  path: string;
  /** The request body for a valid form. */
  body: (form: F) => unknown;
  /** How a failed request is told. */
  failure: FailureOptions;
  /** The toast after a creation. */
  createdToast: string;
  /** Id of the heading of the list the new key shows up in: it gets the focus after "Done". */
  listHeadingId?: string;
}

export interface CreateKeyDialog<F, K extends string> {
  open: boolean;
  form: F;
  update: (patch: Partial<F>) => void;
  errors: Partial<Record<K, string>>;
  /** An error that belongs to no field. */
  formError: string | null;
  pending: boolean;
  /** Set once the key exists: the dialog shows it instead of the form. */
  created: CreatedKey | null;
  onOpenChange: (next: boolean) => void;
  close: () => void;
  submit: (event: React.FormEvent<HTMLFormElement>) => void;
  /** For the dialog content's `onCloseAutoFocus`. */
  onCloseAutoFocus: (event: Event) => void;
}

export function useCreateKeyDialog<F extends { name: string }, K extends string>(
  options: CreateKeyDialogOptions<F, K>,
): CreateKeyDialog<F, K> {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<F>(options.emptyForm);
  const [errors, setErrors] = useState<Partial<Record<K, string>>>({});
  const { pending, error: formError, setError: setFormError, send } = useApiRequest();
  const [created, setCreated] = useState<CreatedKey | null>(null);
  const focusReturn = useFocusReturn();

  function update(patch: Partial<F>): void {
    setForm((f) => ({ ...f, ...patch }));
  }

  function onOpenChange(next: boolean): void {
    if (pending) return;
    if (!next && created) {
      // Resolved when the dialog has closed: the list's heading may only exist after the refresh.
      const { listHeadingId } = options;
      focusReturn.set(
        () => (listHeadingId ? document.getElementById(listHeadingId) : null),
        mainHeading,
      );
      router.refresh();
    }
    if (!next) {
      setForm(options.emptyForm());
      setErrors({});
      setFormError(null);
      setCreated(null);
    }
    setOpen(next);
  }

  async function create(): Promise<void> {
    const invalid = options.validate(form);
    setErrors(invalid);
    setFormError(null);
    if (Object.keys(invalid).length > 0) return;
    const { path, failure } = options;
    const res = await send(path, { method: 'POST', json: options.body(form) }, failure);
    const key = res.status === 201 ? createdKeyFrom(res.body) : null;
    if (key) {
      setCreated({ key, name: form.name.trim() });
      toast.success(options.createdToast);
      return;
    }
    const fieldErrors = fieldErrorsFrom(
      res.status === 400 ? apiErrorDetails(res.body) : undefined,
      options.fields,
    );
    setErrors(fieldErrors);
    // Field errors are shown next to their fields; anything else in the form's own error line.
    setFormError(
      Object.keys(fieldErrors).length > 0 ? null : failureMessage(res.status, res.body, failure),
    );
  }

  return {
    open,
    form,
    update,
    errors,
    formError,
    pending,
    created,
    onOpenChange,
    close: () => onOpenChange(false),
    submit: (event) => {
      event.preventDefault();
      void create();
    },
    onCloseAutoFocus: focusReturn.onCloseAutoFocus,
  };
}
