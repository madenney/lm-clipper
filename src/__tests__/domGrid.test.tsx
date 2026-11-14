/**
 * The DOM grid's limits (tray-v2.md): zooming out must never make it build more
 * elements than the cap, it builds nothing while the GPU overview shows, and the
 * loaded window never starts past the first row on screen. Counts, not timing.
 */
import '@testing-library/jest-dom'
import { render } from '@testing-library/react'
import { DomLayer } from '../renderer/components/Tray/DomLayer'
import type { ClipData } from '../renderer/components/Clip'
import { Selection } from '../lib/selection'
import { clipDisplayConfig, getClipMode } from '../renderer/config/clipDisplay'
import { clipModeFor } from '../renderer/hooks/useClipMode'
import {
  MAX_DOM_TILES,
  SCROLL_BUFFER,
  buildRange,
  nextWindowOffset,
  screenRange,
  showsDomGrid,
  spacerBlocks,
} from '../renderer/lib/domGrid'
import { MAX_SCROLL_PX } from '../renderer/lib/scrollSpace'
import { newHandoff } from '../renderer/lib/viewAnchor'

const CAP = clipDisplayConfig.limits.maxDomElements
const GRID_WINDOW = 2000

// One wheel notch is x0.78: from the largest grid tile down past fit-all for 21M.
const ZOOMS: number[] = []
for (let z = 299; z > 0.2; z *= 0.78) ZOOMS.push(z)
const VIEWPORTS: [number, number][] = [
  [1600, 900],
  [3840, 2160],
  [16000, 9000], // bigger than any screen: the cap must hold anyway
]
const TOTALS = [1, 2_000, 100_000, 21_000_000]

const makeClips = (n: number, from = 0): ClipData[] =>
  Array.from(
    { length: n },
    (_, i) => ({ id: from + i, path: `/r/${from + i}.slp`, stage: 2 }) as never,
  )

// What Tray did before: the grid mounted for every mode but the single card.
const renderGrid = (zoom: number, w: number, h: number, total: number) => {
  const info = clipModeFor({
    zoomSize: zoom,
    totalClips: total,
    trayWidth: w,
    trayHeight: h,
  })
  const onVisibleRange = jest.fn()
  // A small loaded window keeps jsdom quick; the rest of the screen is
  // placeholders, which is where the old grid's element count blew up.
  const loaded = Math.min(100, total)
  const { container, unmount } = render(
    <DomLayer
      clips={makeClips(loaded)}
      mode={info.mode}
      clipSize={info.clipSize}
      gap={info.gap}
      columns={info.columns}
      trayWidth={w}
      trayHeight={h}
      visible={showsDomGrid(info.mode)}
      selection={Selection.none()}
      onClipMouseDown={() => {}}
      onClipMouseEnter={() => {}}
      onBackgroundClick={() => {}}
      startIndex={0}
      total={total}
      onVisibleRange={onVisibleRange}
    />,
  )
  const inner = container.querySelector('.dom-layer > div')
  const built = inner
    ? Array.from(inner.children).filter(
        (el) => !el.classList.contains('reorder-indicator'),
      ).length
    : 0
  const elements = container.querySelectorAll('*').length
  unmount()
  return { info, built, elements, onVisibleRange }
}

describe('DOM grid limits at every zoom', () => {
  it('builds at most the cap, and nothing in the GPU modes', () => {
    for (const total of TOTALS) {
      for (const [w, h] of VIEWPORTS) {
        for (const zoom of ZOOMS) {
          if (getClipMode(zoom) === 'full') continue
          const { info, built, elements, onVisibleRange } = renderGrid(
            zoom,
            w,
            h,
            total,
          )
          const where = `${zoom.toFixed(2)} px, ${w}x${h}, ${total} rows`
          const shown = showsDomGrid(info.mode)
          expect([where, built <= CAP]).toEqual([where, true])
          // Hidden: no element at all and no range report; shown: tiles.
          expect([where, shown ? built > 0 : elements === 0]).toEqual([
            where,
            true,
          ])
          expect([where, onVisibleRange.mock.calls.length > 0]).toEqual([
            where,
            shown,
          ])
        }
      }
    }
  })

  it('only mounts the grid in mode2', () => {
    expect(showsDomGrid('mode2')).toBe(true)
    expect(showsDomGrid('full')).toBe(false)
    expect(showsDomGrid('mode3')).toBe(false)
    expect(showsDomGrid('mode4')).toBe(false)
  })
})

describe('DOM grid window maths', () => {
  // Every zoom, screen, list size and scroll position: tiles + placeholder
  // blocks stay within the cap, and the range covers the screen when it can.
  it('caps tiles + placeholder blocks whatever the loaded window', () => {
    for (const total of TOTALS) {
      for (const [w, h] of VIEWPORTS) {
        for (const zoom of ZOOMS) {
          const info = clipModeFor({
            zoomSize: zoom,
            totalClips: total,
            trayWidth: w,
            trayHeight: h,
          })
          const cellSize = info.clipSize + info.gap
          const totalRows = Math.ceil(total / info.columns)
          for (const rowFrac of [0, 0.37, 1]) {
            const scrollTop = Math.floor(totalRows * rowFrac) * cellSize
            const geometry = {
              scrollTop,
              trayHeight: h,
              cellSize,
              padding: info.gap,
              columns: info.columns,
              total,
            }
            const { start, end } = buildRange(geometry)
            const screen = screenRange(geometry)
            expect(end - start).toBeLessThanOrEqual(MAX_DOM_TILES)
            expect(start).toBeLessThanOrEqual(screen.first)
            expect(end).toBeGreaterThanOrEqual(
              Math.min(screen.last, screen.first + MAX_DOM_TILES),
            )
            // A loaded window bigger than the cap, starting mid-screen.
            const loadedFrom = Math.min(total, start + 7)
            const loadedTo = Math.min(total, loadedFrom + 20_000)
            const tiles = Math.max(
              0,
              Math.min(end, loadedTo) - Math.max(start, loadedFrom),
            )
            const blocks =
              spacerBlocks(
                start,
                Math.min(end, loadedFrom),
                info.columns,
                cellSize,
                info.gap,
                info.clipSize,
              ).length +
              spacerBlocks(
                Math.max(start, loadedTo),
                end,
                info.columns,
                cellSize,
                info.gap,
                info.clipSize,
              ).length
            expect(tiles + blocks).toBeLessThanOrEqual(CAP)
          }
        }
      }
    }
  })

  it('covers a gap with at most 3 blocks that tile it exactly', () => {
    const columns = 7
    for (let from = 0; from < 30; from++) {
      for (let to = from; to < 40; to++) {
        const blocks = spacerBlocks(from, to, columns, 10, 0, 10)
        expect(blocks.length).toBeLessThanOrEqual(3)
        const area = blocks.reduce((s, b) => s + b.width * b.height, 0)
        expect(area).toBe((to - from) * 100)
      }
    }
  })

  it('never starts the loaded window past the first row on screen', () => {
    for (const total of TOTALS) {
      for (const span of [1, 500, 1_999, 2_000, 4_732, 15_000, 1_280_000]) {
        for (const first of [0, 1, 1_000, total >> 1, total - 1]) {
          if (first < 0 || first >= total) continue
          const last = Math.min(total, first + span)
          for (const loadedStart of [0, first, Math.max(0, first - 5_000)]) {
            const want = nextWindowOffset({
              first,
              last,
              loadedStart,
              loadedCount: Math.min(GRID_WINDOW, total - loadedStart),
              total,
              windowRows: GRID_WINDOW,
            })
            if (want === null) continue
            expect(want).toBeGreaterThanOrEqual(0)
            expect(want).toBeLessThanOrEqual(first)
          }
        }
      }
    }
  })

  it('centres the window on a screen smaller than it', () => {
    expect(
      nextWindowOffset({
        first: 10_000,
        last: 11_000,
        loadedStart: 0,
        loadedCount: 2_000,
        total: 100_000,
        windowRows: 2_000,
      }),
    ).toBe(9_500)
    // Already loaded: nothing to do.
    expect(
      nextWindowOffset({
        first: 500,
        last: 1_000,
        loadedStart: 0,
        loadedCount: 2_000,
        total: 100_000,
        windowRows: 2_000,
      }),
    ).toBeNull()
  })
})

describe('DOM grid on a 21M-row list (lib/scrollSpace.ts)', () => {
  it('keeps its scroll area in the browser limit and reaches a deep handoff', () => {
    const total = 21_000_000
    const [w, h] = [1600, 900]
    const info = clipModeFor({
      zoomSize: 120,
      totalClips: total,
      trayWidth: w,
      trayHeight: h,
    })
    expect(showsDomGrid(info.mode)).toBe(true)
    const cell = info.clipSize + info.gap
    // The GPU view was at row 1.5M (crossing 120 px from deep in the list).
    const row = 1_500_000
    const handoff = newHandoff()
    handoff.pinned = { idx: row * info.columns, fy: 0, cy: 0 }
    const start = row * info.columns - 50
    const onVisibleRange = jest.fn()
    const { container, unmount } = render(
      <DomLayer
        clips={makeClips(100, start)}
        mode={info.mode}
        clipSize={info.clipSize}
        gap={info.gap}
        columns={info.columns}
        trayWidth={w}
        trayHeight={h}
        visible
        selection={Selection.none()}
        onClipMouseDown={() => {}}
        onClipMouseEnter={() => {}}
        onBackgroundClick={() => {}}
        startIndex={start}
        total={total}
        onVisibleRange={onVisibleRange}
        handoff={handoff}
      />,
    )
    const layer = container.querySelector('.dom-layer') as HTMLElement
    const inner = layer.firstElementChild as HTMLElement
    const area = parseFloat(inner.style.height)
    // The whole list is ~194M px; the scroll area stays under the ~33.5M limit.
    expect(Math.ceil(total / info.columns) * cell).toBeGreaterThan(150_000_000)
    expect(area).toBeLessThanOrEqual(MAX_SCROLL_PX)
    expect(layer.scrollTop).toBeGreaterThan(0)
    expect(layer.scrollTop).toBeLessThanOrEqual(area - h)
    // That row is on screen, its tiles drawn inside the scroll area around the
    // screen (the built rows include SCROLL_BUFFER rows above it).
    const [first] = onVisibleRange.mock.calls.at(-1)!
    expect(Math.floor(first / info.columns)).toBe(row)
    const tops = Array.from(inner.querySelectorAll('.clip')).map((el) =>
      parseFloat((el as HTMLElement).style.top),
    )
    expect(tops.length).toBeGreaterThan(0)
    expect(Math.min(...tops)).toBeGreaterThanOrEqual(
      layer.scrollTop - (SCROLL_BUFFER + 1) * cell,
    )
    expect(Math.max(...tops)).toBeLessThan(layer.scrollTop + h)
    unmount()
  })
})
