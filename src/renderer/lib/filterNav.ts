/** Window event: move the highlighted filter step up (-1) or down (+1) (Z/X, ↑/↓ in the grid). */
export const STEP_FILTER_EVENT = 'lunar:stepFilter'
export const stepFilter = (delta: -1 | 1) =>
  window.dispatchEvent(new CustomEvent(STEP_FILTER_EVENT, { detail: delta }))

/** A key that moves the filter highlight: -1 up (Z, ↑), +1 down (X, ↓), 0 any other key. */
export function filterStepKey(e: {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
}): -1 | 0 | 1 {
  if (e.ctrlKey || e.metaKey || e.altKey) return 0
  const k = e.key.toLowerCase()
  if (k === 'z' || k === 'arrowup') return -1
  if (k === 'x' || k === 'arrowdown') return 1
  return 0
}
