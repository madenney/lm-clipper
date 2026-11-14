/**
 * Where the GPU view puts the hovered tile's Play / Record buttons: the grid
 * card's (Clip.css `.clip--mode2 .clip-actions`, small tier: 24 px buttons, 6 px
 * from the right, above the 120 px card's info strip) scaled to the tile, so
 * crossing 120 px doesn't make them jump. Buttons never get smaller than a
 * clickable MIN_BTN.
 */
import { overviewGap } from './overviewLayout'

const CARD = 120 // the smallest DOM card
const BTN = 24
const PAD = 6
const FOOT = 32 // the card's info strip + pad: the buttons sit above it
const GAP = 5
export const MIN_BTN = 16

export type TileButtonsGeometry = {
  /** The hovered tile (CSS px, relative to the view). */
  left: number
  top: number
  size: number
  /** Button edge, space between them, distance from the tile's right/bottom. */
  btn: number
  gap: number
  right: number
  bottom: number
}

export function tileButtonsGeometry(
  idx: number,
  cols: number,
  tile: number,
  scroll: number,
  dpr = 1,
): TileButtonsGeometry {
  const gapCss = overviewGap(tile, dpr) / dpr
  const k = Math.min(1, tile / CARD)
  const right = Math.max(2, PAD * k)
  return {
    left: (idx % cols) * tile + gapCss,
    top: Math.floor(idx / cols) * tile - scroll + gapCss,
    size: tile - gapCss,
    btn: Math.max(MIN_BTN, BTN * k),
    gap: Math.max(2, GAP * k),
    right,
    bottom: Math.max(right, FOOT * k),
  }
}
