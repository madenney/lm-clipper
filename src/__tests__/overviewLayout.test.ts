import {
  anchoredScroll,
  clampScroll,
  fitTile,
  indexAt,
  overviewGap,
  overviewLayout,
  rangeOf,
  OVERVIEW_MIN_TILE,
} from '../renderer/lib/overviewLayout'

describe('overview layout (the far-out tray view)', () => {
  it('lays clips out in rows across the width', () => {
    expect(overviewLayout(10, 1000, 2_000)).toEqual({
      cols: 100,
      rows: 20,
      height: 200,
    })
    expect(overviewLayout(0.5, 1000, 2_000_000)).toEqual({
      cols: 2000,
      rows: 1000,
      height: 500,
    })
    expect(overviewLayout(300, 100, 5).cols).toBe(1) // never zero columns
    expect(overviewLayout(10, 1000, 0).rows).toBe(0)
  })

  it('stops zooming out where every clip fits on screen', () => {
    const t = fitTile(1100, 700, 2_000_000)
    const { height } = overviewLayout(t, 1100, 2_000_000)
    expect(height).toBeLessThanOrEqual(700)
    expect(t).toBeGreaterThan(0.5) // ~0.58 for 2M on 1100x700
    expect(fitTile(1920, 1080, 48_000_000)).toBeGreaterThan(OVERVIEW_MIN_TILE) // ~0.2
    expect(fitTile(0, 700, 10)).toBe(OVERVIEW_MIN_TILE)
  })

  it('finds the clip under a point, and nothing outside the grid', () => {
    // 100 per row, 10 px tiles, scrolled 25 px.
    expect(indexAt(5, 5, 10, 100, 0, 2000)).toBe(0)
    expect(indexAt(15, 5, 10, 100, 0, 2000)).toBe(1)
    expect(indexAt(5, 5, 10, 100, 25, 2000)).toBe(300) // row 3
    expect(indexAt(1005, 5, 10, 100, 0, 2000)).toBe(-1) // past the last column
    expect(indexAt(5, 205, 10, 100, 0, 2000)).toBe(-1) // past the last clip
    expect(indexAt(-1, 5, 10, 100, 0, 2000)).toBe(-1)
    // Sub-pixel tiles: 2 clips per px across.
    expect(indexAt(10, 0, 0.5, 2000, 0, 2_000_000)).toBe(20)
  })

  it('keeps the clip under the cursor in place when zooming', () => {
    // Clip 523 at 10 px, 100 per row: row 5, cursor 40 px down, 30% into the tile.
    const before = { tile: 10, cols: 100 }
    const s0 = anchoredScroll(523, 0.3, 40, before.tile, before.cols)
    expect(indexAt(235, 40, before.tile, before.cols, s0, 10_000)).toBe(523)
    // Zoom to 20 px: 50 per row; the same clip is still under the same y.
    const s1 = anchoredScroll(523, 0.3, 40, 20, 50)
    const row = Math.floor((40 + s1) / 20)
    expect(row).toBe(Math.floor(523 / 50))
  })

  it('clamps scrolling and orders ranges', () => {
    expect(clampScroll(-5, 1000, 400)).toBe(0)
    expect(clampScroll(900, 1000, 400)).toBe(600)
    expect(clampScroll(50, 300, 400)).toBe(0) // content shorter than the view
    expect(rangeOf(9, 3)).toEqual([3, 9])
  })

  it('only puts gaps between tiles that are big enough', () => {
    expect(overviewGap(3, 1)).toBe(0)
    expect(overviewGap(20, 1)).toBe(1)
    expect(overviewGap(20, 1.5)).toBe(2) // Windows 150% scaling
  })
})
