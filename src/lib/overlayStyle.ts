/**
 * The video overlay's text size (Settings > Overlay > Size): pixels on a 1080p
 * video. Other resolutions scale it, as they scale the rest of the label.
 * Shared by Settings (the box's limits) and the renderer in the main process.
 */
export const OVERLAY_FONT_SIZE_DEFAULT = 24
export const OVERLAY_FONT_SIZE_MIN = 10
export const OVERLAY_FONT_SIZE_MAX = 120

/** A stored size as a whole number in range; anything else is the default. */
export function clampOverlayFontSize(value: unknown): number {
  const n = typeof value === 'number' ? value : parseInt(String(value), 10)
  if (!Number.isFinite(n)) return OVERLAY_FONT_SIZE_DEFAULT
  return Math.min(
    OVERLAY_FONT_SIZE_MAX,
    Math.max(OVERLAY_FONT_SIZE_MIN, Math.round(n)),
  )
}
