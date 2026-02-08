// NOTE: Temporary tuning knobs while we dial in zoom behavior.
// TODO: Revisit and replace with persisted config/UI controls.
export const zoomConfig = {
  minZoom: 0.1,
  defaultColumns: 5,
  maxZoomFloor: 500,
  scrollSpeed: 0.06,
  // Multiplier per zoom button press.
  zoomButtonStep: 1.12,
  fitToTray: true,
  gapRatioMin: 0.04,
  gapRatioMax: 0.12,
  gapRatioMinAt: 20,
  gapRatioMaxAt: 140,
  minGapRatio: 0.02,
  minGapFloor: 0,
  // Switch to density mode when the tray would show more than this many items.
  densityMaxVisibleItems: 80000,
  // Delay density fetches while scrolling to keep UI responsive.
  densityFetchDebounceMs: 120,
  // Switch to canvas-only rendering (solid colors) beyond this count.
  canvasRenderAt: 20000,
  // Thresholds are visible element counts (on-screen).
  // Zoom-out order: gaps -> borders -> low-res -> solid colors.
  gapOffAt: 1200,
  borderOffAt: 2000,
  lowResAt: 1000,
  solidColorAt: 80000,
  stageSolidColors: {
    dl: '#d0fcd1', // Dream Land
    ys: '#d38b86', // Yoshi's Story
    bf: '#212631', // Battlefield
    fd: '#473169', // Final Destination
    fod: '#113536', // Fountain of Dreams
    ps: '#3b382c', // Pokemon Stadium
  },
  infoStageAt: 800,

  infoPlayersAt: 500,
  infoLengthAt: 300,
  infoFileAt: 150,
} as const
