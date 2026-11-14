/**
 * Keeping your place across zooms (docs/tray-v2.md). The DOM grid (120 px and
 * up) and the GPU view (below) are separate components with their own scroll;
 * each writes where it is (scroll + geometry) into one shared handoff after every
 * change, and the other starts from it when the zoom crosses over, so the clip
 * under the cursor (or at the top, for the buttons and slider) stays where it
 * was. The anchor is worked out when it's used, so it follows the cursor of the
 * zoom that crossed. The DOM grid also keeps it across its own zooms. Plain
 * functions, tested directly (src/__tests__/viewAnchor.test.tsx).
 */

/** Clip `idx`'s row sits `cy` px below the view's top, `fy` (0..1) of the way down its tile. */
export type ViewAnchor = { idx: number; fy: number; cy: number }

export type Grid = {
  /** Distance between rows/columns (tile + gap). */
  cell: number
  /** Space above the first row and left of the first column. */
  padding: number
  cols: number
  total: number
}

/** Where a view is: its scroll and geometry. */
export type ViewPlace = { scroll: number; grid: Grid }

/** Shared by both views (Tray holds one). */
export type ViewHandoff = {
  place: ViewPlace | null
  /** Where the zoom centres (px from the view's top-left): the cursor of the
   *  last Ctrl+wheel, null for the buttons and slider (the top row). */
  focus: { x: number; y: number } | null
  /** A clip to show instead (closing Single shows the clip you were on); the
   *  next view to write its place clears it. */
  pinned: ViewAnchor | null
}

export const newHandoff = (): ViewHandoff => ({
  place: null,
  focus: null,
  pinned: null,
})

/** The clip at the focus (or the top-left one) and where it sits. */
export function anchorAt(
  scroll: number,
  focus: { x: number; y: number } | null,
  { cell, padding, cols, total }: Grid,
): ViewAnchor | null {
  if (cell <= 0 || cols <= 0 || total <= 0) return null
  const cx = focus ? focus.x : 0
  const cy = focus ? focus.y : 0
  const fyAll = (scroll + cy - padding) / cell
  const row = Math.max(0, Math.floor(fyAll))
  const col = Math.max(0, Math.min(cols - 1, Math.floor((cx - padding) / cell)))
  return {
    idx: Math.max(0, Math.min(total - 1, row * cols + col)),
    fy: Math.max(0, Math.min(1, fyAll - row)),
    cy,
  }
}

/** The scroll that puts the anchor's row back where it was, clamped to the content. */
export function scrollFor(
  anchor: ViewAnchor,
  { cell, padding, cols, total }: Grid,
  viewHeight: number,
  contentHeight: number,
): number {
  if (cell <= 0 || cols <= 0) return 0
  const idx = Math.max(0, Math.min(Math.max(0, total - 1), anchor.idx))
  const row = Math.floor(idx / cols)
  const want = padding + (row + anchor.fy) * cell - anchor.cy
  return Math.max(0, Math.min(Math.max(0, contentHeight - viewHeight), want))
}

/** Where the next view should start: the pinned clip, or the clip at the focus
 *  in the view that wrote its place last. */
export function handoffAnchor(h: ViewHandoff | undefined): ViewAnchor | null {
  if (!h) return null
  if (h.pinned) return h.pinned
  return h.place ? anchorAt(h.place.scroll, h.focus, h.place.grid) : null
}

/** A view records where it is (and the pinned clip, if any, has been shown). */
export function writePlace(h: ViewHandoff | undefined, place: ViewPlace) {
  if (!h) return
  h.place = place
  h.pinned = null
}
