'use client';
/**
 * The state behind an "Edit" dialog of a key (D-111), shared by user keys and service keys: the
 * form, filled from the key as it is when the dialog opens, its errors and the request. Each dialog
 * brings its own form shape, validation, endpoint and wording, and renders its own fields
 * (key-dialog-parts.tsx has the pieces).
 *
 * - Submit validates on the client first, then PATCHes. A 200 closes the dialog with a toast and
 *   reloads the list (router.refresh()); the server's 400 `details` are shown next to their fields;
 *   anything else goes in the form's error line. A 409 (the key was revoked or expired meanwhile)
 *   reloads the list as well, so the key moves to the other section.
 * - While the request runs the dialog can't be closed. Every close resets the form, and the focus
 *   goes back to the trigger.
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
import { useFocusReturn } from '@/lib/focus';
import { useApiRequest } from '@/lib/use-api-request';

export interface EditKeyDialogOptions<F, K extends string> {
  /** The form as the key is now. */
  initialForm: () => F;
  /** Client-side checks before sending (the server checks everything again). */
  validate: (form: F) => Partial<Record<K, string>>;
  /** The form's fields the server's 400 `details` can name. */
  fields: readonly K[];
  /** The key's path (PATCH). */
  path: string;
  /** The request body for a valid form. */
  body: (form: F) => unknown;
  /** How a failed request is told. */
  failure: FailureOptions;
  /** The toast after a save. */
  savedToast: string;
}

export interface EditKeyDialog<F, K extends string> {
  open: boolean;
  form: F;
  update: (patch: Partial<F>) => void;
  errors: Partial<Record<K, string>>;
  /** An error that belongs to no field. */
  formError: string | null;
  pending: boolean;
  /** Always null: an edit never shows a key (KeyDialog's "created" view). */
  created: null;
  onOpenChange: (next: boolean) => void;
  close: () => void;
  submit: (event: React.FormEvent<HTMLFormElement>) => void;
  /** For the dialog content's `onCloseAutoFocus`: the trigger gets the focus back. */
  onCloseAutoFocus: (event: Event) => void;
}

export function useEditKeyDialog<F, K extends string>(
  options: EditKeyDialogOptions<F, K>,
): EditKeyDialog<F, K> {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<F>(options.initialForm);
  const [errors, setErrors] = useState<Partial<Record<K, string>>>({});
  const { pending, error: formError, setError: setFormError, send } = useApiRequest();
  // Never `set`: Radix's default, the trigger, which stays after a save (the key is still active).
  const focusReturn = useFocusReturn();

  function update(patch: Partial<F>): void {
    setForm((f) => ({ ...f, ...patch }));
  }

  function onOpenChange(next: boolean): void {
    if (pending) return;
    // Filled again on every open: the key may have changed since the page was rendered.
    setForm(options.initialForm());
    setErrors({});
    setFormError(null);
    setOpen(next);
  }

  async function save(): Promise<void> {
    const invalid = options.validate(form);
    setErrors(invalid);
    setFormError(null);
    if (Object.keys(invalid).length > 0) return;
    const { path, failure } = options;
    const res = await send(path, { method: 'PATCH', json: options.body(form) }, failure);
    if (res.ok) {
      setOpen(false);
      toast.success(options.savedToast);
      router.refresh();
      return;
    }
    if (res.status === 409) router.refresh();
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
    created: null,
    onOpenChange,
    close: () => onOpenChange(false),
    submit: (event) => {
      event.preventDefault();
      void save();
    },
    onCloseAutoFocus: focusReturn.onCloseAutoFocus,
  };
}
