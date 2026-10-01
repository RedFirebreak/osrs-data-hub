/**
 * The error text under a form field: nothing without a message. Give it the id the field's
 * `aria-describedby` names. Hand-written (not a shadcn component).
 */
function FieldError({ id, message }: { id: string; message: string | undefined }) {
  if (!message) return null;
  return (
    <p id={id} className="text-sm text-destructive">
      {message}
    </p>
  );
}

export { FieldError };
