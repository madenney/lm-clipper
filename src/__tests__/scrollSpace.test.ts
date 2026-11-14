/**
 * The DOM grid past the browser's scroll limit (lib/scrollSpace.ts): Chromium
 * stops a scroll area at ~33.5M px, a 21M-clip list at 120 px is ~194M px. The
 * grid's scroll area stays under MAX_SCROLL_PX and maps to a logical scroll, so
 * every row can be reached; wheel steps still move 1:1. Lists that fit are
 * unchanged.
 */
import { screenRange } from '../renderer/lib/domGrid'
import {
  MAX_SCROLL_PX,
  physicalFor,
  scrollAreaHeight,
  scrollStep,
} from '../renderer/lib/scrollSpace'

// The grid at its smallest DOM zoom: 120 px tiles + 6 px gaps, 1600 px wide.
const CELL = 126
const PAD = 6
const COLS = Math.floor((1600 - PAD) / CELL)
const VIEW = 900
const contentFor = (total: number) => Math.ceil(total / COLS) * CELL + PAD * 2
const geometry = (scrollTop: number, total: number) => ({
  scrollTop,
  trayHeight: VIEW,
  cellSize: CELL,
  padding: PAD,
  columns: COLS,
  total,
})

describe('the DOM grid on a 21M-row list', () => {
  const total = 21_000_000
  const content = contentFor(total)
  const area = scrollAreaHeight(content)

  it('keeps its scroll area under the browser limit', () => {
    expect(content).toBeGreaterThan(150_000_000)
    expect(area).toBe(MAX_SCROLL_PX)
    expect(area).toBeLessThan(33_554_428)
  })

  it('the wheel reaches the very end from deep in the list', () => {
    let phys = Math.round((area - VIEW) * 0.999)
    let { logical, offset } = scrollStep(0, phys, 0, content, VIEW)
    let stuck = 0
    for (let i = 0; i < 2_000_000 && logical < content - VIEW; i += 1) {
      const next = Math.min(area - VIEW, phys + 120)
      if (next === phys) stuck += 1
      const step = scrollStep(phys, next, offset, content, VIEW)
      ;({ logical, offset } = step)
      phys = step.rebase ?? next
    }
    expect(stuck).toBe(0)
    expect(logical).toBe(content - VIEW)
  })

  it('reaches the last row: the scrollbar at the bottom is the end of the list', () => {
    const step = scrollStep(0, area - VIEW, 0, content, VIEW)
    expect(step.logical).toBe(content - VIEW)
    expect(screenRange(geometry(step.logical, total)).last).toBe(total)
  })

  it('a scrollbar drag goes to the same fraction of the list', () => {
    const phys = Math.round((area - VIEW) * 0.37)
    const step = scrollStep(0, phys, 0, content, VIEW)
    expect(step.logical / (content - VIEW)).toBeCloseTo(0.37, 6)
    // Tiles are drawn at top - offset: the screen's top is the physical scroll.
    expect(step.logical - step.offset).toBe(step.rebase ?? phys)
  })

  it('wheel steps move 1:1, and the wheel never runs out of room before the end', () => {
    let phys = 0
    let offset = 0
    let logical = 0
    let uneven = 0
    let outside = 0
    // 200,000 notches of 120 px: 24M px, past the scroll area's whole height.
    for (let i = 0; i < 200_000; i += 1) {
      const next = Math.min(area - VIEW, phys + 120)
      const step = scrollStep(phys, next, offset, content, VIEW)
      if (Math.abs(step.logical - logical - 120) > 1e-6) uneven += 1
      logical = step.logical
      offset = step.offset
      phys = step.rebase ?? next
      if (phys < 0 || phys > area - VIEW) outside += 1
    }
    expect(uneven).toBe(0)
    expect(outside).toBe(0)
    expect(logical).toBe(200_000 * 120)
    // ...and back up to the top: the wheel gets all the way there (a notch at
    // scroll 0 fires no scroll event, so it must never be stuck there early).
    let stuck = 0
    for (let i = 0; i < 400_000 && logical > 0; i += 1) {
      const next = Math.max(0, phys - 120)
      if (next === phys) stuck += 1
      const step = scrollStep(phys, next, offset, content, VIEW)
      logical = step.logical
      offset = step.offset
      phys = step.rebase ?? next
    }
    expect(stuck).toBe(0)
    expect(logical).toBe(0)
    expect(phys).toBe(0)
  })

  it('a deep handoff lands on its row (physical scroll in range)', () => {
    const row = 1_500_000
    const logical = PAD + row * CELL
    const phys = physicalFor(logical, content, VIEW)
    expect(phys).toBeGreaterThan(0)
    expect(phys).toBeLessThanOrEqual(area - VIEW)
    // The tile for the first clip of that row sits at the screen's top.
    const offset = logical - phys
    expect(PAD + row * CELL - offset).toBe(phys)
    expect(screenRange(geometry(logical, total)).first).toBe(row * COLS)
  })
})

describe('lists that fit', () => {
  it('are untouched: logical = physical, no offset', () => {
    const content = contentFor(100_000)
    expect(scrollAreaHeight(content)).toBe(content)
    expect(physicalFor(37_806, content, VIEW)).toBe(37_806)
    expect(scrollStep(0, 37_806, 0, content, VIEW)).toEqual({
      logical: 37_806,
      offset: 0,
      rebase: null,
    })
  })
})
