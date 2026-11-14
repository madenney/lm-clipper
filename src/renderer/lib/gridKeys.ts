/**
 * Keyboard moves in the clip grid. The grid is one focusable list (the cards are not tab stops:
 * hundreds of them would make Tab useless); the arrow keys move a highlighted card, like a file
 * list. Positions are global (the whole result list), `columns` is the grid's width.
 */

/** Where an arrow / Home / End / Page key moves the highlight from `current`, or null for a key
 *  that is not a move. Stays inside [0, total). */
export function gridKeyTarget(
  key: string,
  current: number,
  columns: number,
  total: number,
): number | null {
  if (total <= 0 || columns <= 0) return null
  const last = total - 1
  const clamp = (i: number) => Math.max(0, Math.min(last, i))
  switch (key) {
    case 'ArrowLeft':
      return clamp(current - 1)
    case 'ArrowRight':
      return clamp(current + 1)
    case 'ArrowUp':
      return clamp(current - columns)
    case 'ArrowDown':
      return clamp(current + columns)
    case 'PageUp':
      return clamp(current - columns * 4)
    case 'PageDown':
      return clamp(current + columns * 4)
    case 'Home':
      return 0
    case 'End':
      return last
    default:
      return null
  }
}

/** The scroll (logical px) that brings the card at `index` fully into view, or the current one
 *  when it already is. Rows are `cell` tall, the first starts `padding` down. */
export function scrollToShow(
  index: number,
  columns: number,
  cell: number,
  padding: number,
  tile: number,
  scrollTop: number,
  viewHeight: number,
): number {
  if (columns <= 0 || cell <= 0) return scrollTop
  const top = padding + Math.floor(index / columns) * cell
  const bottom = top + tile
  if (top < scrollTop) return Math.max(0, top - padding)
  if (bottom > scrollTop + viewHeight) return bottom - viewHeight + padding
  return scrollTop
}
