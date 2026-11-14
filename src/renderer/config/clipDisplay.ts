/**
 * Clip Display Configuration
 *
 * Controls how clips are rendered across the 4 display modes:
 * - full:  the single card (DOM)
 * - mode2: DOM grid, 120-299 px: cards that lead with what the step found
 *          (hits + damage, edgeguard score, the game's players), a strength
 *          meter, a kill badge and Play/Record in the corner on hover
 * - mode3: GPU, 2-119 px: the grid's card look (stage art + both character
 *          icons) down to ~24 px, then stage colour + icon, then squares
 * - mode4: GPU, below 2 px: several clips per pixel
 * (docs/tray-v2.md; the GPU view is components/Tray/OverviewCanvas.tsx)
 */

export type ClipMode = 'full' | 'mode2' | 'mode3' | 'mode4'

export const clipDisplayConfig = {
  // Zoom size thresholds (px) for mode transitions
  thresholds: {
    full: 300, // >= 300px = full mode (DOM, scrollable)
    // >= 120px = mode 2 (DOM grid); below, the GPU view draws the tiles (a zoom
    // step there is one draw; DOM cards at 40-45 px cost ~150 ms a step)
    mode2: 120,
    mode3: 2, // >= 2px = mode 3 (GPU)
    // below 2px = mode 4 (GPU micro)
  },

  // Hard limits
  limits: {
    // Most elements the DOM grid builds (tiles + placeholder blocks), whatever
    // the screen size: enforced by lib/domGrid.ts.
    maxDomElements: 15000,
  },

  // Feature visibility by minimum clip size (px). The DOM grid starts at
  // thresholds.mode2, so the card always has its lead line and buttons; more
  // lines join as it grows (Clip.tsx).
  features: {
    buttons: { minSize: 120 },
    // The GPU view's hover Play/Record (components/Tray/OverviewCanvas.tsx):
    // a DOM overlay on the hovered tile from this size up, scaled with the tile.
    gpuButtons: { minSize: 40 },
    // Lead line + length: "5 hits · 48%   4.1s".
    text: { minSize: 120 },
    // Second line: "85% → 117% · Up-air", edgeguard facts, a game's date.
    detail: { minSize: 165 },
    // Third line: the players (in the tooltip below this).
    names: { minSize: 220 },
    charIcons: { minSize: 30 },
    borders: { minSize: 20 },
    gaps: { minSize: 15 },
  },

  // Visual styling
  style: {
    gapRatio: 0.05, // gap as fraction of tile size
    minGap: 2, // minimum gap in px
    borderWidth: 1, // border width in px
    infoMaxHeight: 0.4, // info overlay max height as fraction
    borderColor: '#2f3a34',
    borderColorFull: '#2a2a2a',
    backgroundColor: '#000000',
    backgroundColorFull: '#131313',
  },

  // Stage colors for GPU mode - averaged from 9px stage images
  stageColors: {
    bf: '#201B20', // Battlefield
    fd: '#271739', // Final Destination
    dl: '#74A982', // Dreamland
    fod: '#494257', // Fountain of Dreams
    ys: '#AAC0A3', // Yoshi's Story
    ps: '#313A38', // Pokemon Stadium
    default: '#2a2a2a',
  },
} as const

/**
 * Determine the display mode from the zoom size. The DOM grid caps its own
 * element count (limits.maxDomElements), so the screen size doesn't matter.
 */
export const getClipMode = (zoomSize: number): ClipMode => {
  const { thresholds } = clipDisplayConfig

  if (zoomSize >= thresholds.full) {
    return 'full'
  }

  if (zoomSize >= thresholds.mode2) {
    return 'mode2'
  }

  // GPU modes
  if (zoomSize >= thresholds.mode3) {
    return 'mode3'
  }
  return 'mode4'
}

/**
 * Check if a feature should be visible at the given clip size
 */
export const isFeatureVisible = (
  feature: keyof typeof clipDisplayConfig.features,
  clipSize: number,
): boolean => {
  return clipSize >= clipDisplayConfig.features[feature].minSize
}

/**
 * Calculate gap size for a given clip size
 */
export const getGapSize = (clipSize: number): number => {
  const { gapRatio, minGap } = clipDisplayConfig.style
  if (clipSize < clipDisplayConfig.features.gaps.minSize) {
    return 0
  }
  return Math.max(minGap, Math.round(clipSize * gapRatio))
}

/**
 * Check if mode uses DOM rendering
 */
export const isDomMode = (mode: ClipMode): boolean => {
  return mode === 'full' || mode === 'mode2'
}

/**
 * Check if mode uses GPU rendering
 */
export const isGpuMode = (mode: ClipMode): boolean => {
  return mode === 'mode3' || mode === 'mode4'
}

/**
 * Check if mode supports scrolling
 */
export const isScrollable = (mode: ClipMode): boolean => {
  return mode === 'full'
}
