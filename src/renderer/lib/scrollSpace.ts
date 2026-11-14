/**
 * The DOM grid's scroll beyond the browser's limit (components/Tray/DomLayer.tsx).
 * Chromium stops a scroll area at ~33.5M px (a 34M px div renders 33,554,428 px
 * tall), and a 21M-clip list at 120 px tiles is ~194M px, so most of it could
 * not be scrolled to. The grid's real scroll area stays under MAX_SCROLL_PX and
 * the grid works in a logical scroll that can be any size:
 *
 *   logical = physical + offset
 *
 * Wheel, keys and touch move the physical scroll a little at a time; those
 * steps move the logical scroll by the same amount (1:1, so scrolling feels
 * normal). A big jump is the scrollbar being dragged or clicked: then the
 * logical scroll goes to the same fraction of the list (the thumb is honest).
 * When 1:1 steps bring the physical scroll near either end with list still left
 * beyond it, the physical scroll is moved back to its proportional place
 * (`rebase`), so the wheel never hits the end of the scroll area early.
 * Lists that fit keep offset 0 (logical = physical), exactly as before.
 */

/** The grid's real scroll area never exceeds this (well under ~33.5M px). */
export const MAX_SCROLL_PX = 15_000_000

/** A scroll event moving at most this many screens is a step (1:1). A
 *  scrollbar drag moves the 15M px area by ~20,000 px per mouse pixel. */
const STEP_SCREENS = 3

/** The height the grid's scroll area gets for content this tall. */
export const scrollAreaHeight = (content: number) =>
  Math.min(content, MAX_SCROLL_PX)

const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v))

/** The physical scroll for a logical one: its proportional place. */
export function physicalFor(logical: number, content: number, view: number) {
  const area = scrollAreaHeight(content)
  const lMax = Math.max(0, content - view)
  if (area >= content) return clamp(logical, 0, lMax)
  const pMax = Math.max(0, area - view)
  return lMax > 0 ? Math.round((clamp(logical, 0, lMax) / lMax) * pMax) : 0
}

export type ScrollStep = {
  /** Where the grid is (logical px). */
  logical: number
  /** logical - physical, for drawing (tiles are placed at their top - offset). */
  offset: number
  /** Move the physical scroll here (near an end with list left); null: don't. */
  rebase: number | null
}

/**
 * A scroll event: the physical scroll went from `prevPhys` to `phys`, with
 * `offset` from the last step.
 */
export function scrollStep(
  prevPhys: number,
  phys: number,
  offset: number,
  content: number,
  view: number,
): ScrollStep {
  const area = scrollAreaHeight(content)
  const lMax = Math.max(0, content - view)
  if (area >= content)
    return { logical: clamp(phys, 0, lMax), offset: 0, rebase: null }
  const pMax = Math.max(0, area - view)
  let logical =
    Math.abs(phys - prevPhys) <= view * STEP_SCREENS
      ? clamp(phys + offset, 0, lMax)
      : pMax > 0
        ? (clamp(phys, 0, pMax) / pMax) * lMax
        : 0
  // At an end of the scroll area with only a few px of list left: that's the end.
  if (phys <= 0 && physicalFor(logical, content, view) <= 0) logical = 0
  if (phys >= pMax && physicalFor(logical, content, view) >= pMax)
    logical = lMax
  // Within a screen of either end of the scroll area, but not of the list (or
  // at the very end, where the next wheel step would fire no scroll event):
  // move back to the proportional place so the next steps have room.
  const fair = physicalFor(logical, content, view)
  const nearEnd = phys < view || phys > pMax - view
  const atEnd = (phys <= 0 && logical > 0) || (phys >= pMax && logical < lMax)
  const rebase =
    (nearEnd && Math.abs(fair - phys) > view) || (atEnd && fair !== phys)
      ? fair
      : null
  return { logical, offset: logical - (rebase ?? phys), rebase }
}
