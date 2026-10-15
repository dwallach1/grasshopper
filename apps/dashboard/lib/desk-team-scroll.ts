/**
 * Pin a Team steward block to the top of the team scroller.
 * The block is the roster row (card + scorecard), not the scorecard alone.
 * Previous scrollTop is part of the rect delta, then clamped to the scroller.
 */

function cssAttr(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}

/** Scroll offset that aligns `section` with the top of `scroller`, before clamping. */
export function unclampedScrollTop(scroller: HTMLElement, section: HTMLElement): number {
  const delta = section.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  const next = scroller.scrollTop + delta;
  if (!Number.isFinite(next)) return 0;
  return Math.max(0, next);
}

/** Scroll offset that aligns `section` with the top of `scroller`. */
export function scrollTopForSection(scroller: HTMLElement, section: HTMLElement): number {
  const next = unclampedScrollTop(scroller, section);
  const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  return Math.min(next, max);
}

const SCROLL_TAIL = 'data-team-scroll-tail';

/**
 * The last roster row cannot reach the top of the scroller unless the page
 * has room below it. A flex list ignores bottom padding, so a tail sibling
 * supplies the shortfall. It is removed when the row already fits.
 */
function extendRosterForPin(stage: HTMLElement, section: HTMLElement): void {
  stage.querySelector(`[${SCROLL_TAIL}]`)?.remove();
  const raw = unclampedScrollTop(stage, section);
  const max = Math.max(0, stage.scrollHeight - stage.clientHeight);
  const short = raw - max;
  if (short <= 0.5) return;
  const tail = document.createElement('div');
  tail.setAttribute(SCROLL_TAIL, '');
  tail.setAttribute('aria-hidden', 'true');
  tail.style.height = `${Math.ceil(short)}px`;
  tail.style.flex = '0 0 auto';
  stage.append(tail);
}

/** The steward's roster row, which starts at the card and includes the scorecard. */
export function teamStewardBlock(stage: ParentNode, slug: string): HTMLElement | null {
  const name = slug.trim();
  if (!name) return null;
  const card = stage.querySelector<HTMLElement>(`.team-card[data-steward="${cssAttr(name)}"]`);
  if (!card) return null;
  const block = card.closest('li');
  return block instanceof HTMLElement ? block : card;
}

/** Move `stage` so the named steward's row sits at the top of that scroller. */
export function scrollTeamStageToSteward(stage: HTMLElement, slug: string): boolean {
  const block = teamStewardBlock(stage, slug);
  if (!block) return false;
  extendRosterForPin(stage, block);
  stage.scrollTop = scrollTopForSection(stage, block);
  return true;
}
