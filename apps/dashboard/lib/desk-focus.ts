/**
 * Chrome refuses aria-hidden on an ancestor of the focused element.
 * Blur that focus before the ancestor is hidden.
 */

export function blurFocusWithin(root: Element | null | undefined): void {
  if (!root) return;
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return;
  if (!root.contains(active)) return;
  active.blur();
}

/** Blur focus that lives in a desk page other than the one about to be shown. */
export function blurFocusLeavingSurface(nextSurface: string): void {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return;
  const page = active.closest('[data-desk-page]');
  if (!(page instanceof HTMLElement)) return;
  if (page.getAttribute('data-desk-page') === nextSurface) return;
  active.blur();
}
