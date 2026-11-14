/**
 * The GPU view's scroll in float32 (lib/overviewScroll.ts): the shader gets the
 * first row on screen as an int plus the px into it, so deep in a 21M-row list
 * every pixel shows the clip a click there picks (overviewLayout.ts indexAt).
 * The shader's maths is repeated with Math.fround; the old single-float scroll
 * is checked too, to show the test catches what it fixed.
 */
import { indexAt, overviewLayout } from '../renderer/lib/overviewLayout'
import { shaderIndexAt, splitScroll } from '../renderer/lib/overviewScroll'

const f32 = Math.fround

/** The old shader: the scroll as one float32. */
function unsplitIndexAt(
  x: number,
  y: number,
  tile: number,
  cols: number,
  scroll: number,
  total: number,
) {
  const t = f32(tile)
  const py = f32(f32(y + 0.5) + f32(scroll))
  const col = Math.floor(f32(f32(x + 0.5) / t))
  const row = Math.floor(f32(py / t))
  const idx = row * cols + col
  return col < cols && idx >= 0 && idx < total ? idx : -1
}

/** Screen pixel rows (every one not right on a tile edge) drawn as the wrong clip. */
function wrongRows(
  at: typeof shaderIndexAt,
  { total, tileCss, dpr, widthCss, heightCss }: Record<string, number>,
) {
  const { cols, height } = overviewLayout(tileCss, widthCss, total)
  const tile = tileCss * dpr
  const h = Math.round(heightCss * dpr)
  // The bottom of the list, where the scroll is largest.
  const scroll = Math.round(Math.max(0, height - heightCss) * dpr)
  let wrong = 0
  let rows = 0
  for (let y = 0; y < h; y += 1) {
    // Not within a hair of a row edge (where rounding may go either way).
    const into = (y + 0.5 + (scroll - Math.floor(scroll / tile) * tile)) % tile
    if (into < 0.01 || tile - into < 0.01) continue
    rows += 1
    for (const x of [Math.floor(tile / 2), Math.floor((cols - 0.5) * tile)]) {
      const want = indexAt(
        (x + 0.5) / dpr,
        (y + 0.5) / dpr,
        tileCss,
        cols,
        scroll / dpr,
        total,
      )
      if (at(x, y, tile, cols, scroll, total) !== want) {
        wrong += 1
        break
      }
    }
  }
  return { wrong, rows }
}

const CASES = [
  { total: 21_000_000, tileCss: 119, dpr: 1, widthCss: 1600, heightCss: 900 },
  { total: 21_000_000, tileCss: 119, dpr: 1.5, widthCss: 1600, heightCss: 900 },
  { total: 21_000_000, tileCss: 60, dpr: 1.25, widthCss: 1600, heightCss: 900 },
  { total: 21_000_000, tileCss: 40, dpr: 1, widthCss: 3840, heightCss: 2000 },
  { total: 5_000_000, tileCss: 100, dpr: 1, widthCss: 1600, heightCss: 900 },
]

describe('the GPU view deep in a huge list', () => {
  it.each(CASES)(
    'draws the clip a click picks on every row ($total rows, $tileCss px, dpr $dpr)',
    (c) => {
      const { wrong, rows } = wrongRows(shaderIndexAt, c)
      expect(rows).toBeGreaterThan(0)
      expect(wrong).toBe(0)
    },
  )

  it('the old single-float scroll put rows in the wrong place there', () => {
    const { wrong } = wrongRows(unsplitIndexAt, CASES[0])
    expect(wrong).toBeGreaterThan(0)
  })

  it('splits the scroll into whole rows and a small rest', () => {
    const { firstRow, frac } = splitScroll(192_000_123.5, 178.5)
    expect(Number.isInteger(firstRow)).toBe(true)
    expect(frac).toBeGreaterThanOrEqual(0)
    expect(frac).toBeLessThan(178.5)
    expect(firstRow * 178.5 + frac).toBeCloseTo(192_000_123.5, 6)
    // The rest is small, so float32 keeps it to well under a pixel.
    expect(Math.abs(f32(frac) - frac)).toBeLessThan(1e-4)
    expect(splitScroll(500, 0)).toEqual({ firstRow: 0, frac: 0 })
  })
})
