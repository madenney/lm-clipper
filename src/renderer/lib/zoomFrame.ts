/**
 * Tray zoom input, applied at most once per animation frame (docs/tray-v2.md).
 *
 * Trackpad pinches and fast wheels send 60-120 events a second and each zoom
 * re-renders the tray, so the live zoom is kept here and every input (wheel,
 * pinch, slider, buttons) moves it; one state update goes out per frame.
 */

/** Pixels per line for line-mode wheels (DOM_DELTA_LINE: many Windows mice). */
export const WHEEL_LINE_PX = 40
/** One page-mode wheel step (DOM_DELTA_PAGE) counts as one ordinary notch. */
export const WHEEL_PAGE_PX = 100
/** The most one wheel event may zoom by, in pixel-delta terms (a few notches). */
export const WHEEL_ZOOM_MAX_PX = 300
/** Zoom speed: a 100 px notch multiplies the tile by about 0.78 (or 1.28). */
export const WHEEL_ZOOM_RATE = 0.0025

/**
 * A wheel event's vertical delta in pixels, whatever unit it came in.
 * `pageHeight` is what one page-mode step scrolls (for scrolling, not zoom).
 */
export function wheelDeltaPx(
  e: { deltaY: number; deltaMode: number },
  pageHeight: number,
): number {
  if (e.deltaMode === 1) return e.deltaY * WHEEL_LINE_PX
  if (e.deltaMode === 2) return e.deltaY * pageHeight
  return e.deltaY
}

/**
 * How much one Ctrl/⌘+wheel event zooms (multiply the tile by it). Ratio-based,
 * so pinches (small pixel deltas, many events) and notches both feel even; a
 * line- or page-mode notch zooms like a pixel-mode one.
 */
export function wheelZoomFactor(e: { deltaY: number; deltaMode: number }) {
  const px = Math.max(
    -WHEEL_ZOOM_MAX_PX,
    Math.min(WHEEL_ZOOM_MAX_PX, wheelDeltaPx(e, WHEEL_PAGE_PX)),
  )
  return Math.exp(-px * WHEEL_ZOOM_RATE)
}

export type ZoomFrame = {
  /** The zoom as the input has left it (ahead of the rendered one mid-frame). */
  live: () => number
  /** Zoom to a size (clamped); applied on the next frame. */
  to: (_zoom: number) => void
  /** Multiply the live zoom (clamped); applied on the next frame. */
  by: (_factor: number) => void
  /** The rendered zoom changed (from here or elsewhere): follow it. */
  sync: (_zoom: number) => void
  /** Drop a pending update (unmount). */
  cancel: () => void
}

export function createZoomFrame(opts: {
  initial: number
  clamp: (_zoom: number) => number
  commit: (_zoom: number) => void
  schedule?: (_cb: () => void) => number
  unschedule?: (_id: number) => void
}): ZoomFrame {
  const schedule =
    opts.schedule ?? ((cb: () => void) => window.requestAnimationFrame(cb))
  const unschedule =
    opts.unschedule ?? ((id: number) => window.cancelAnimationFrame(id))
  // Last value sent out; the state may lag it by a render.
  let committed = opts.initial
  let pending: number | null = null
  let frame: number | null = null

  const live = () => pending ?? committed
  const flush = () => {
    frame = null
    if (pending == null) return
    const next = pending
    pending = null
    if (next === committed) return
    committed = next
    opts.commit(next)
  }
  const to = (zoom: number) => {
    if (!Number.isFinite(zoom)) return
    pending = opts.clamp(zoom)
    if (frame == null) frame = schedule(flush)
  }
  return {
    live,
    to,
    by: (factor) => to(live() * factor),
    sync: (zoom) => {
      committed = zoom
    },
    cancel: () => {
      if (frame != null) unschedule(frame)
      frame = null
      pending = null
    },
  }
}
