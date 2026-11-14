/**
 * The GPU view's scroll as the shader gets it (components/Tray/OverviewCanvas.tsx).
 * Shader floats are 32-bit: deep in a 21M-row list the scroll is ~200M device
 * px, where float32 steps are 16-32 px, so a scroll sent as one float puts rows
 * in the wrong place and smears each tile into bands. It goes as the whole
 * first row on screen (an int) plus how far into that row the screen starts (a
 * small float), and the shader works out rows from those.
 *
 * `shaderIndexAt` repeats the shader's maths in float32 (Math.fround), so tests
 * can check that what is drawn matches what a click picks (overviewLayout.ts
 * indexAt) anywhere in the list.
 */

const f32 = Math.fround

/** The scroll (device px) as the first row on screen and the px into it. */
export function splitScroll(scroll: number, tile: number) {
  if (!(tile > 0)) return { firstRow: 0, frac: 0 }
  const firstRow = Math.floor(scroll / tile)
  return { firstRow, frac: Math.max(0, scroll - firstRow * tile) }
}

/**
 * The clip the shader draws at device pixel (x, y) from the top-left (the
 * pixel's centre is x + 0.5, y + 0.5), with its float32 maths; -1 for none.
 * Tiles of 1 device px or more (below that several clips share a pixel).
 */
export function shaderIndexAt(
  x: number,
  y: number,
  tile: number,
  cols: number,
  scroll: number,
  total: number,
) {
  const { firstRow, frac } = splitScroll(scroll, tile)
  const t = f32(tile)
  const fy = f32(f32(y + 0.5) + f32(frac))
  const col = Math.floor(f32(f32(x + 0.5) / t))
  const row = firstRow + Math.floor(f32(fy / t))
  const idx = row * cols + col
  return col < cols && idx >= 0 && idx < total ? idx : -1
}
