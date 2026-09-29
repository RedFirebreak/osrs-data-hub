/**
 * Where keyboard focus goes when a dialog or menu closes after an action that removed, disabled or
 * re-rendered the control that opened it (revoking a device or an API key, removing or blocking a
 * player, handing an account on, an admin action followed by router.refresh(), WCAG 2.4.3).
 *
 * Radix returns focus to the trigger on close. When the trigger is gone, disabled while the request
 * runs, or the dialog has no Trigger at all (opened from a menu item or a switch), the focus lands on
 * <body> and keyboard and screen-reader users lose their place. The fix is the same everywhere: move
 * the focus to a stable element nearby, normally the heading of the section the control was in:
 *
 *   const focusReturn = useFocusReturn();
 *   // the action succeeded, just before closing:
 *   focusReturn.set(headingOfSection(triggerRef.current));
 *   <AlertDialogContent onCloseAutoFocus={focusReturn.onCloseAutoFocus}>
 *
 * Client-only at run time, but free of browser globals at import (the web tests run in node and use
 * fake elements).
 */
import { useRef } from 'react';

/** An element, nothing, or a function giving one when the dialog closes (it may not exist before). */
export type FocusTarget = HTMLElement | null | undefined | (() => HTMLElement | null | undefined);

/**
 * The heading that names the nearest section around `el`: the element referenced by the closest
 * ancestor with `aria-labelledby` (its first id), e.g. `<section aria-labelledby="connected-devices">`.
 * Null when there is none. Read it while `el` is still in the page (before the refresh removes it).
 */
export function headingOfSection(el: Element | null | undefined): HTMLElement | null {
  const section = el?.parentElement?.closest('[aria-labelledby]');
  const id = section?.getAttribute('aria-labelledby')?.trim().split(/\s+/)[0];
  if (!section || !id) return null;
  return section.ownerDocument.getElementById(id);
}

/** The page's h1 inside <main>: the last resort, present on every page. */
export function mainHeading(): HTMLElement | null {
  return typeof document === 'undefined' ? null : document.querySelector<HTMLElement>('main h1');
}

/**
 * Focuses the first of `targets` that is still in the page and takes the focus; true when one did.
 * An element that isn't focusable by itself (a heading) gets tabindex="-1" for as long as it has the
 * focus, so script can focus it without adding it to the Tab order.
 */
export function moveFocus(...targets: FocusTarget[]): boolean {
  for (const target of targets) {
    const el = typeof target === 'function' ? target() : target;
    if (!el?.isConnected) continue;
    const added = !el.hasAttribute('tabindex') && el.tabIndex < 0;
    if (added) el.setAttribute('tabindex', '-1');
    el.focus();
    if (el.ownerDocument.activeElement === el) {
      if (added) el.addEventListener('blur', () => el.removeAttribute('tabindex'), { once: true });
      return true;
    }
    // Disabled, hidden or inert: try the next one.
    if (added) el.removeAttribute('tabindex');
  }
  return false;
}

/** Nothing useful has the focus: it is on <body> (or nowhere), or on an element no longer in the page. */
export function focusIsLost(doc: Document = document): boolean {
  const active = doc.activeElement;
  return active === null || active === doc.body || !active.isConnected;
}

export interface FocusReturn {
  /**
   * Where the focus goes when the dialog or menu next closes (the first target that can take it),
   * instead of the trigger. Call it once the action succeeded, before closing.
   */
  set(...targets: FocusTarget[]): void;
  /** Pass to the Radix content's `onCloseAutoFocus`. Without a `set` since the last close, Radix's default applies. */
  onCloseAutoFocus(event: Event): void;
}

/** See the file comment. */
export function useFocusReturn(): FocusReturn {
  const pending = useRef<FocusTarget[] | null>(null);
  return {
    set(...targets) {
      pending.current = targets;
    },
    onCloseAutoFocus(event) {
      const targets = pending.current;
      pending.current = null;
      if (targets && moveFocus(...targets)) event.preventDefault();
    },
  };
}
