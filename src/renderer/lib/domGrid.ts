/**
 * The DOM grid's window maths (120–299 px tiles, tray-v2.md): which positions it
 * builds, how unloaded stretches are drawn, and which rows Tray keeps loaded.
 * Pure, so the limits can be checked for any zoom, screen and list size.
 */

import { clipDisplayConfig, type ClipMode } from '../config/clipDisplay'

/** Extra rows built above/below the screen. */
export const SCROLL_BUFFER = 2

/** A gap of unloaded positions is drawn as at most 3 blocks (head row, middle
 *  rows, tail row); the loaded window is one run, so there are at most 2 gaps. */
export const MAX_SPACER_BLOCKS = 6

/** Most tiles the grid ever builds, so tiles + spacer blocks stay within
 *  maxDomElements. */
export const MAX_DOM_TILES =
  clipDisplayConfig.limits.maxDomElements - MAX_SPACER_BLOCKS

/** Only the DOM grid mode mounts the grid; the GPU overview draws everything
 *  further out, and 'full' is the single card. */
export const showsDomGrid = (mode: ClipMode): boolean => mode === 'mode2'

export type GridGeometry = {
  scrollTop: number
  trayHeight: number
  cellSize: number
  padding: number
  columns: number
  total: number
}

/** The positions on screen, [first, last), without the buffer rows. */
export const screenRange = ({
  scrollTop,
  trayHeight,
  cellSize,
  padding,
  columns,
  total,
}: GridGeometry): { first: number; last: number } => {
  if (cellSize <= 0 || columns <= 0 || total <= 0) return { first: 0, last: 0 }
  const firstRow = Math.max(0, Math.floor((scrollTop - padding) / cellSize))
  const lastRow = Math.max(
    firstRow,
    Math.ceil((scrollTop + trayHeight) / cellSize),
  )
  return {
    first: Math.min(total, firstRow * columns),
    last: Math.min(total, lastRow * columns),
  }
}

/** The positions the grid builds, [start, end): the screen plus SCROLL_BUFFER
 *  rows either side, never more than maxTiles (the buffer goes first, then rows
 *  off the bottom of the screen). */
export const buildRange = (
  geometry: GridGeometry,
  maxTiles: number = MAX_DOM_TILES,
): { start: number; end: number } => {
  const { scrollTop, trayHeight, cellSize, padding, columns, total } = geometry
  if (cellSize <= 0 || columns <= 0 || total <= 0) return { start: 0, end: 0 }
  const screenFirstRow = Math.max(
    0,
    Math.floor((scrollTop - padding) / cellSize),
  )
  const firstRow = Math.max(0, screenFirstRow - SCROLL_BUFFER)
  const lastRow = Math.ceil((scrollTop + trayHeight) / cellSize) + SCROLL_BUFFER
  let start = Math.min(total, firstRow * columns)
  let end = Math.min(total, (lastRow + 1) * columns)
  if (end - start > maxTiles) {
    start = Math.min(total, screenFirstRow * columns)
    end = Math.min(total, start + maxTiles)
  }
  return { start, end }
}

export type Rect = { top: number; left: number; width: number; height: number }

/** Unloaded positions [from, to) as at most 3 rectangles: the rest of the first
 *  row, the whole rows between, the start of the last row. */
export const spacerBlocks = (
  from: number,
  to: number,
  columns: number,
  cellSize: number,
  padding: number,
  clipSize: number,
): Rect[] => {
  if (to <= from || columns <= 0) return []
  const blocks: Rect[] = []
  const rect = (row: number, col: number, rows: number, cols: number) =>
    blocks.push({
      top: padding + row * cellSize,
      left: padding + col * cellSize,
      width: (cols - 1) * cellSize + clipSize,
      height: (rows - 1) * cellSize + clipSize,
    })
  const firstRow = Math.floor(from / columns)
  const lastRow = Math.floor((to - 1) / columns)
  const firstCol = from % columns
  const endCol = ((to - 1) % columns) + 1
  if (firstRow === lastRow) {
    rect(firstRow, firstCol, 1, endCol - firstCol)
    return blocks
  }
  let midStart = firstRow
  if (firstCol > 0) {
    rect(firstRow, firstCol, 1, columns - firstCol)
    midStart = firstRow + 1
  }
  const midEnd = endCol < columns ? lastRow : lastRow + 1
  if (midEnd > midStart) rect(midStart, 0, midEnd - midStart, columns)
  if (endCol < columns) rect(lastRow, 0, 1, endCol)
  return blocks
}

/**
 * Where the loaded window should start for what's on screen [first, last), or
 * null when the rows loaded already cover it. Centred on the screen when it fits,
 * and never past the first row on screen (a screen taller than the window keeps
 * its top rows loaded).
 */
export const nextWindowOffset = ({
  first,
  last,
  loadedStart,
  loadedCount,
  total,
  windowRows,
  margin = 200,
}: {
  first: number
  last: number
  loadedStart: number
  loadedCount: number
  total: number
  windowRows: number
  margin?: number
}): number | null => {
  const loadedEnd = loadedStart + loadedCount
  const needMore =
    first < loadedStart || (last > loadedEnd - margin && loadedEnd < total)
  if (!needMore) return null
  const want = first - Math.floor((windowRows - (last - first)) / 2)
  return Math.max(0, Math.min(first, want))
}
