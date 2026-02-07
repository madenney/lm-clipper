/**
 * Clip Display Configuration
 *
 * Controls how clips are rendered across the 4 display modes:
 * - full:  DOM, scrollable, full detail
 * - mode2: DOM, no scroll, compact with buttons/text
 * - mode3: GPU, stage + character icons
 * - mode4: GPU, colored squares only
 */

export type ClipMode = 'full' | 'mode2' | 'mode3' | 'mode4'

export const clipDisplayConfig = {
  // Zoom size thresholds (px) for mode transitions
  thresholds: {
    full: 300,   // >= 300px = full mode (DOM, scrollable)
    mode2: 5,    // >= 5px = mode 2 (DOM grid)
    mode3: 2,    // >= 2px = mode 3 (GPU)
    // below 2px = mode 4 (GPU micro)
  },

  // Hard limits
  limits: {
    maxDomElements: 15000, // Force GPU if more than this visible
  },

  // Feature visibility by minimum clip size (px)
  features: {
    buttons: { minSize: 80 },
    text: { minSize: 80 },
    charIcons: { minSize: 30 },
    borders: { minSize: 20 },
    gaps: { minSize: 15 },
  },

  // Visual styling
  style: {
    gapRatio: 0.05,       // gap as fraction of tile size
    minGap: 2,            // minimum gap in px
    borderWidth: 1,       // border width in px
    infoMaxHeight: 0.4,   // info overlay max height as fraction
    borderColor: '#ffffff',
    borderColorFull: '#2a2a2a',
    backgroundColor: '#000000',
    backgroundColorFull: '#131313',
  },

  // Stage colors for GPU mode - averaged from 9px stage images
  stageColors: {
    bf: '#201B20',    // Battlefield
    fd: '#271739',    // Final Destination
    dl: '#74A982',    // Dreamland
    fod: '#494257',   // Fountain of Dreams
    ys: '#AAC0A3',    // Yoshi's Story
    ps: '#313A38',    // Pokemon Stadium
    default: '#2a2a2a',
  },
} as const

/**
 * Determine the display mode based on zoom size and visible count
 */
export const getClipMode = (zoomSize: number, visibleCount: number): ClipMode => {
  const { thresholds, limits } = clipDisplayConfig

  if (zoomSize >= thresholds.full) {
    return 'full'
  }

  // Use DOM mode2 if zoom is large enough AND under the element limit
  if (zoomSize >= thresholds.mode2 && visibleCount <= limits.maxDomElements) {
    return 'mode2'
  }

  // GPU modes - either zoom is small or too many elements
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
  clipSize: number
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
