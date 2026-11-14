/**
 * The far-out tray view's geometry (docs/tray-v2.md), shared by the GPU shader,
 * the CPU fallback and the mouse: which clip is at a point, how many columns, how
 * far you can scroll, where zooming out stops. Plain functions so they're tested
 * directly (src/__tests__/overviewLayout.test.ts).
 */
export const OVERVIEW_MIN_TILE = 0.02

/** Columns, rows and content height (CSS px) at a tile size. */
export function overviewLayout(tile: number, width: number, total: number) {
  const cols = Math.max(1, Math.floor(width / tile))
  const rows = Math.ceil(Math.max(0, total) / cols)
  return { cols, rows, height: rows * tile }
}

/** The tile size at which every clip fits on screen: zooming out further is pointless. */
export function fitTile(width: number, height: number, total: number) {
  if (total <= 0 || width <= 0 || height <= 0) return OVERVIEW_MIN_TILE
  return Math.max(OVERVIEW_MIN_TILE, Math.sqrt((width * height) / total) * 0.97)
}

/** Gap between tiles (device px): none when tiles are small. */
export function overviewGap(tileCss: number, dpr: number) {
  return tileCss >= 6 ? Math.max(1, Math.round(tileCss * dpr * 0.06)) : 0
}

/** The clip index at a point (CSS px, relative to the view), or -1. */
export function indexAt(
  x: number,
  y: number,
  tile: number,
  cols: number,
  scroll: number,
  total: number,
) {
  if (x < 0 || y < 0) return -1
  const col = Math.floor(x / tile)
  const row = Math.floor((y + scroll) / tile)
  const idx = row * cols + col
  return col < cols && idx >= 0 && idx < total ? idx : -1
}

/** Clamp a scroll offset to the content. */
export function clampScroll(
  scroll: number,
  contentHeight: number,
  viewHeight: number,
) {
  return Math.max(0, Math.min(Math.max(0, contentHeight - viewHeight), scroll))
}

/**
 * The scroll that keeps the clip under the cursor in place after a zoom.
 * `fy` is how far down its tile the cursor was (0..1).
 */
export function anchoredScroll(
  idx: number,
  fy: number,
  cy: number,
  tile: number,
  cols: number,
) {
  const row = Math.floor(idx / cols)
  return (row + fy) * tile - cy
}

/** The rows of clip indexes [first, last] a range selection covers, in order. */
export function rangeOf(a: number, b: number): [number, number] {
  return a <= b ? [a, b] : [b, a]
}
