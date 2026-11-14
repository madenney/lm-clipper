/**
 * Tiles below the DOM grid on the GPU (tray-v2.md): under 120 px the tray mounts
 * no clip elements at all, the GPU view draws the grid's card look (stage art,
 * both icons and the arrow or "vs", placed like the card's) from ~24 px, and crossing between the two (or closing
 * Single) keeps your place. Counts and positions, not timing.
 */
import '@testing-library/jest-dom'
import { act, useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { Tray } from '../renderer/components/Tray/Tray'
import OverviewCanvas, {
  cpuDraw,
} from '../renderer/components/Tray/OverviewCanvas'
import {
  OVERVIEW_STAGE_NONE,
  stageOfByte,
  toneOfByte,
} from '../renderer/lib/overviewStore'
import { clipDisplayConfig } from '../renderer/config/clipDisplay'
import { clipModeFor } from '../renderer/hooks/useClipMode'
import { showsDomGrid } from '../renderer/lib/domGrid'
import {
  ARROW_DARK,
  ARROW_LIGHT,
  CARD_LAYOUT_IDS,
  CARD_LAYOUTS,
  CARD_LOOK,
  cardLayoutForStep,
  ICON_COLS,
  ICON_ROWS,
  NUM_CHARS,
  VS_CELL,
  VS_FONT,
  VS_WEIGHT,
  stageLayers,
  TONE_HOT,
  TONE_KILL,
  tileLook,
  type Rect,
  type TileArt,
} from '../renderer/lib/tileArt'
import {
  anchorAt,
  handoffAnchor,
  newHandoff,
  scrollFor,
  writePlace,
} from '../renderer/lib/viewAnchor'
import { Selection } from '../lib/selection'
import { SelectionMask } from '../renderer/lib/overviewMask'
import type { ShallowArchiveInterface } from '../constants/types'

// Rows: id = position + 1; stage/characters vary by position.
const mockState = { rows: 0, freshReads: 0 }
// More than a few results removed from a step ask first: answer the question.
async function confirmRemove() {
  const button = screen.queryByRole('button', { name: 'Remove' })
  if (button)
    await act(async () => {
      fireEvent.click(button)
    })
}

jest.mock('../renderer/ipcBridge', () => ({
  __esModule: true,
  default: {
    getResults: jest.fn(
      (
        req: { offset: number; limit: number },
        cb: (_r: { items: unknown[]; total: number }) => void,
      ) => {
        const n = Math.max(0, Math.min(req.limit, mockState.rows - req.offset))
        cb({
          items: Array.from({ length: n }, (_, i) => ({
            id: req.offset + i + 1,
            path: `/r/${req.offset + i + 1}.slp`,
            stage: 8,
            startFrame: 0,
            endFrame: 60,
          })),
          total: mockState.rows,
        })
      },
    ),
    getOverviewChunk: (
      req: { cursor: { key: number; id: number } | null; limit: number },
      cb: (_res: unknown) => void,
    ) => {
      const from = req.cursor ? req.cursor.id : 0
      if (!req.cursor) mockState.freshReads += 1
      const n = Math.max(0, Math.min(req.limit, mockState.rows - from))
      const packed = new Uint8Array(n * 3)
      for (let i = 0; i < n; i += 1) {
        packed[i * 3] = 31
        packed[i * 3 + 1] = (from + i) % 26
        packed[i * 3 + 2] = (from + i + 1) % 26
      }
      cb({
        ids: new Uint32Array(n).map((_, i) => from + i + 1),
        packed,
        next:
          from + n < mockState.rows ? { key: from + n, id: from + n } : null,
      })
    },
    getTableDuration: jest.fn(),
    getSelectionDuration: jest.fn(),
    removeResults: jest.fn(),
    removeGames: jest.fn(),
    reorderClips: jest.fn(),
    debugLog: jest.fn(),
    database: jest.fn(),
  },
}))
jest.mock('../renderer/debugLog', () => ({ debugLog: () => {} }))
jest.mock('../renderer/components/AddReplays', () => ({
  __esModule: true,
  default: () => null,
  IncomingReplays: () => null,
}))
// Stage pictures by name, so stageLayers can be checked; the dark stages (Fountain,
// Stadium, Battlefield, Final Destination) take the light arrow.
jest.mock('../renderer/lib/clipAssets', () => ({
  ...jest.requireActual('../renderer/lib/clipAssets'),
  arrowImages: { dark: 'dark.png', light: 'light.png' },
  getArrowImage: (id: number) =>
    [2, 3, 31, 32].includes(id) ? 'light.png' : 'dark.png',
  resolveStageImage: (id: number) =>
    ({ 2: 'fountain.jpg', 3: 'stadium.jpg', 31: 'bf.jpg', 32: 'fd.jpg' })[id] ??
    'nonlegal.jpg',
}))
// The art is "built" at once (jsdom loads no images).
const mockArt: { art: TileArt | null } = { art: null }
jest.mock('../renderer/lib/tileArt', () => ({
  ...jest.requireActual('../renderer/lib/tileArt'),
  tileArtNow: () => mockArt.art,
  loadTileArt: () => new Promise(() => {}),
}))

const W = 1200
const H = 810
beforeAll(() => {
  ;(window as unknown as { electron: unknown }).electron = {
    ipcRenderer: { on: () => () => {} },
  }
  ;(window as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}

    disconnect() {}
  }
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => W,
  })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => H,
  })
})
afterAll(() => {
  delete (HTMLElement.prototype as unknown as Record<string, unknown>)
    .clientWidth
  delete (HTMLElement.prototype as unknown as Record<string, unknown>)
    .clientHeight
})

describe('which sizes are DOM', () => {
  it('the DOM grid starts at 120 px; everything smaller is the GPU view', () => {
    expect(clipDisplayConfig.thresholds.mode2).toBe(120)
    for (let z = 299; z > 0.2; z *= 0.97) {
      const { mode, isGpu } = clipModeFor({
        zoomSize: z,
        totalClips: 21_000_000,
        trayWidth: 3840,
        trayHeight: 2160,
      })
      expect(showsDomGrid(mode)).toBe(z >= 120)
      expect(isGpu).toBe(z < 120)
    }
  })
})

describe('tile art', () => {
  it('fades the card look in from 24 px, the far-out icon from 10 px', () => {
    expect(tileLook(8)).toEqual({
      icons: 0,
      card: 0,
      strip: 0,
      ring: 1,
      tint: 0,
    })
    expect(tileLook(18)).toEqual({
      icons: 1,
      card: 0,
      strip: 0,
      ring: 1,
      tint: 0,
    })
    expect(tileLook(28).card).toBeCloseTo(0.5)
    for (const t of [32, 40, 45, 80, 119]) expect(tileLook(t).card).toBe(1)
    // The card's (empty) info strip joins before the DOM grid takes over, so
    // crossing 120 px doesn't add it all at once.
    expect(tileLook(40).strip).toBe(0)
    expect(tileLook(76).strip).toBeCloseTo(0.5)
    for (const t of [96, 119]) expect(tileLook(t).strip).toBe(1)
  })

  const inside = (r: Rect, box: Rect) =>
    r[0] > box[0] && r[1] > box[1] && r[2] < box[2] && r[3] < box[3]
  const side = (r: Rect) => r[2] - r[0]

  it('clips: two equal icons with the arrow between, on one dark pill', () => {
    const { char1, mid, char2, midCell, midAlpha, chip, chipRadius } =
      CARD_LAYOUTS.arrow
    for (const r of [char1, mid, char2]) {
      expect(r[0]).toBeGreaterThanOrEqual(0)
      expect(r[2]).toBeLessThanOrEqual(1)
      expect(side(r)).toBeCloseTo(r[3] - r[1]) // square, like the icon files
      expect(inside(r, chip)).toBe(true) // all three on the one backing
    }
    expect(midCell).toBe(ARROW_LIGHT)
    expect(midAlpha).toBeCloseTo(0.8)
    expect(char1[2]).toBeLessThan(mid[0])
    expect(mid[2]).toBeLessThan(char2[0])
    expect(char1[0]).toBeCloseTo(1 - char2[2]) // centred
    expect(side(char1)).toBeCloseTo(0.26) // equal 26% icons
    expect(side(char2)).toBeCloseTo(0.26)
    expect(char1[1]).toBeCloseTo(0.22)
    expect(char2[1]).toBeCloseTo(0.22)
    expect(side(mid)).toBeCloseTo(0.09)
    // The arrow sits on the icons' middle line.
    expect((mid[1] + mid[3]) / 2).toBeCloseTo((char1[1] + char1[3]) / 2)
    // A pill, clear of the info strip.
    expect(chipRadius).toBeCloseTo((chip[3] - chip[1]) / 2)
    expect(chip[3]).toBeLessThan(1 - CARD_LOOK.strip - 0.15)
  })

  it('games: the same two icons with a big "vs" between', () => {
    const a = CARD_LAYOUTS.arrow
    const { char1, mid, char2, midCell, midAlpha, chip } = CARD_LAYOUTS.versus
    // Same icons and backing as a clip: only the middle changes.
    expect(char1).toEqual(a.char1)
    expect(char2).toEqual(a.char2)
    expect(chip).toEqual(a.chip)
    expect(midCell).toBe(VS_CELL)
    expect(midAlpha).toBe(1)
    // Centred on the space between the icons and bigger than the arrow.
    expect((mid[0] + mid[2]) / 2).toBeCloseTo((char1[2] + char2[0]) / 2)
    expect(side(mid)).toBeCloseTo(mid[3] - mid[1]) // square, like its atlas cell
    expect(side(mid)).toBeGreaterThan(side(a.mid) * 1.5)
    expect((mid[1] + mid[3]) / 2).toBeCloseTo((char1[1] + char1[3]) / 2)
    expect(inside(mid, chip)).toBe(true)
    // Letters big and heavy enough to notice (about 14 px on a 130 px card).
    expect(side(mid) * VS_FONT * 130).toBeGreaterThan(13)
    expect(VS_WEIGHT).toBeGreaterThanOrEqual(800)
  })

  it('the icon atlas holds the characters, both arrows and the "vs"', () => {
    expect(ARROW_DARK).toBe(NUM_CHARS)
    expect(ARROW_LIGHT).toBe(NUM_CHARS + 1)
    expect(VS_CELL).toBe(NUM_CHARS + 2)
    expect(ICON_ROWS * ICON_COLS).toBeGreaterThan(VS_CELL)
  })

  it('a step takes its layout from the nearest producer at or above it', () => {
    const steps = (...types: string[]) => types.map((type) => ({ type }))
    expect(cardLayoutForStep(steps('files'), 0)).toBe('versus')
    const combos = steps('files', 'slpParser', 'comboFilter', 'sort')
    expect(cardLayoutForStep(combos, 0)).toBe('versus')
    expect(cardLayoutForStep(combos, 1)).toBe('arrow')
    expect(cardLayoutForStep(combos, 3)).toBe('arrow')
    const edge = steps('files', 'edgeguard', 'edgeguardFilter', 'trim')
    expect(cardLayoutForStep(edge, 2)).toBe('arrow')
    expect(cardLayoutForStep(edge, 3)).toBe('arrow')
    expect(cardLayoutForStep(steps('lunarClips', 'sort'), 1)).toBe('arrow')
    expect(cardLayoutForStep(undefined, 0)).toBe('versus')
    expect(cardLayoutForStep(combos, -1)).toBe('versus')
  })

  it('gives each stage picture one layer', () => {
    const { info, urls } = stageLayers()
    expect(urls).toHaveLength(5)
    expect(info[31]).not.toBe(info[32])
    expect(info[0]).toBe(info[40]) // both non-legal: one picture
    expect(urls[info[31]]).toBe('bf.jpg')
    for (const v of info) expect(v).toBeLessThan(urls.length)
  })
})

describe('keeping your place', () => {
  const dom = { cell: 126, padding: 6, cols: 9, total: 100_000 }
  const gpu = { cell: 88.9, padding: 0, cols: 13, total: 100_000 }

  it('finds the clip under the cursor and puts it back under the cursor', () => {
    const a = anchorAt(6 + 300 * 126 + 63, { x: 200, y: 100 }, dom)!
    // Row 300 at the top, half of it scrolled past; the cursor is 100 px down
    // (row 301) and in column 1.
    expect(a.idx).toBe(301 * 9 + 1)
    expect(a.cy).toBe(100)
    const s = scrollFor(a, gpu, H, Math.ceil(100_000 / 13) * 88.9)
    const back = anchorAt(s, { x: 0, y: 100 }, gpu)!
    expect(Math.floor(back.idx / 13)).toBe(Math.floor(a.idx / 13))
    expect(back.fy).toBeCloseTo(a.fy)
  })

  it('clamps to the content', () => {
    expect(scrollFor({ idx: 5, fy: 0, cy: 400 }, gpu, H, 1e6)).toBe(0)
    expect(scrollFor({ idx: 99_999, fy: 1, cy: 0 }, gpu, H, 5000)).toBe(
      5000 - H,
    )
  })

  it('a pinned clip wins until a view writes its place', () => {
    const h = newHandoff()
    writePlace(h, { scroll: 0, grid: dom })
    h.pinned = { idx: 777, fy: 0.5, cy: 300 }
    expect(handoffAnchor(h)).toEqual({ idx: 777, fy: 0.5, cy: 300 })
    writePlace(h, { scroll: 126 * 2 + 6, grid: dom })
    expect(h.pinned).toBeNull()
    expect(handoffAnchor(h)?.idx).toBe(18)
  })
})

/* A recording WebGL2 stand-in: uniforms by name, texture uploads. */
const fakeGl = (log: {
  uniforms: Map<string, number>
  layers: number[]
  sources?: string[]
}) => {
  const gl: Record<string, unknown> = {
    shaderSource: (_sh: unknown, src: string) => log.sources?.push(src),
    MAX_TEXTURE_SIZE: 0x0d33,
    getParameter: (p: number) => (p === 0x0d33 ? 4096 : 0),
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    createShader: () => ({}),
    createProgram: () => ({}),
    createBuffer: () => ({}),
    createTexture: () => ({}),
    getUniformLocation: (_p: unknown, name: string) => name,
    uniform1f: (name: string, v: number) => log.uniforms.set(name, v),
    uniform1i: (name: string, v: number) => log.uniforms.set(name, v),
    texImage3D: (...a: unknown[]) => log.layers.push(a[5] as number),
    isContextLost: () => false,
    getExtension: () => null,
  }
  return new Proxy(gl, {
    get: (t, k: string) =>
      k in t ? t[k] : /^[A-Z_0-9]+$/.test(k) ? 1 : () => null,
  })
}

describe('the GPU view draws cards', () => {
  let log: {
    uniforms: Map<string, number>
    layers: number[]
    sources: string[]
  }
  let spy: jest.SpyInstance
  beforeEach(() => {
    log = { uniforms: new Map(), layers: [], sources: [] }
    spy = jest
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockImplementation(((kind: string) =>
        kind === 'webgl2' ? fakeGl(log) : null) as never)
    const canvas = () => document.createElement('canvas')
    mockArt.art = {
      icons: canvas(),
      stages: canvas(),
      layers: 5,
      stageInfo: new Int32Array(64),
    }
  })
  afterEach(() => {
    spy.mockRestore()
    mockArt.art = null
  })

  const view = (tile: number) => (
    <OverviewCanvas
      filterId={`cards-${tile}`}
      dataVersion="1"
      total={1000}
      tile={tile}
      width={W}
      height={H}
      selection={Selection.none()}
      onSelectionChange={() => {}}
      onZoom={() => {}}
    />
  )

  it('uploads the stage art as one layer per picture and draws cards at 40-119 px', async () => {
    mockState.rows = 1000
    for (const tile of [40, 45, 80, 119]) {
      log.uniforms.clear()
      let v!: ReturnType<typeof render>
      await act(async () => {
        v = render(view(tile))
      })
      expect(log.layers).toContain(5)
      expect(log.uniforms.get('uCard')).toBe(1)
      expect(log.uniforms.get('uArt')).toBe(1)
      v.unmount()
    }
  })

  it('the kill / standout ring down to 6 px, the whole tile tinted below', async () => {
    mockState.rows = 1000
    for (const [tile, ring, tint] of [
      [118, 1, 0],
      [85, 1, 0],
      [60, 1, 0],
      [24, 1, 0],
      [8, 1, 0],
      [6, 1, 0],
      [2, 0, 1],
      [0.5, 0, 1],
    ]) {
      log.uniforms.clear()
      let v!: ReturnType<typeof render>
      await act(async () => {
        v = render(view(tile))
      })
      expect([tile, log.uniforms.get('uRing')]).toEqual([tile, ring])
      expect([tile, log.uniforms.get('uTint')]).toEqual([tile, tint])
      // 1.5 CSS px, like the card's ring (jsdom: 1 device px per CSS px).
      expect(log.uniforms.get('uRingW')).toBe(CARD_LOOK.ringWidth)
      v.unmount()
    }
    const frag = log.sources.find((src) => src.includes('uRingW'))!
    expect(frag).toContain(`KILL = vec3(${(229 / 255).toFixed(4)}`)
    expect(frag).toContain(`HOT = vec3(${(227 / 255).toFixed(4)}`)
  })

  it('far out, no card look', async () => {
    await act(async () => {
      render(view(8))
    })
    expect(log.uniforms.get('uCard')).toBe(0)
    expect(log.uniforms.get('uIcons')).toBe(0)
  })

  it("places the icons by the step's layout (a game's players by default)", async () => {
    mockState.rows = 1000
    let v!: ReturnType<typeof render>
    await act(async () => {
      v = render(view(80))
    })
    expect(log.uniforms.get('uLayout')).toBe(CARD_LAYOUT_IDS.versus)
    for (const layout of ['arrow', 'versus'] as const) {
      await act(async () => {
        v.rerender(
          <OverviewCanvas
            filterId="cards-80"
            dataVersion="1"
            total={1000}
            tile={80}
            width={W}
            height={H}
            layout={layout}
            selection={Selection.none()}
            onSelectionChange={() => {}}
            onZoom={() => {}}
          />,
        )
      })
      expect(log.uniforms.get('uLayout')).toBe(CARD_LAYOUT_IDS[layout])
    }
    v.unmount()
  })
})

/* ------------------------------ the whole tray ------------------------------ */

const archive = (results: number): ShallowArchiveInterface => ({
  path: '/p.lunar',
  name: 'p',
  createdAt: 0,
  files: results,
  filters: [
    {
      id: 'files',
      type: 'files',
      label: 'Games',
      isProcessed: true,
      params: {},
      results,
    },
    {
      id: 'f1',
      type: 'comboFilter',
      label: 'Combos',
      isProcessed: true,
      params: {},
      results,
    },
  ],
})

function Harness({ results }: { results: number }) {
  const [selection, setSelection] = useState(Selection.none())
  const [, setLast] = useState<number | null>(null)
  const [, setDur] = useState<number | null>(null)
  return (
    <Tray
      openInSingle={false}
      archive={archive(results)}
      activeFilterId="f1"
      selection={selection}
      setSelection={setSelection}
      lastSelectedIndex={null}
      setLastSelectedIndex={setLast}
      setSelectionDuration={setDur}
      addStartFrames={0}
      addEndFrames={0}
    />
  )
}

const flush = async (ms = 200) => {
  await act(async () => {
    jest.advanceTimersByTime(ms)
  })
}
const clickZoom = async (label: 'Zoom in' | 'Zoom out') => {
  await act(async () => {
    fireEvent.click(screen.getByLabelText(label))
  })
  await flush(50) // the zoom's animation frame
}
/** The clip number Single opens on ("Clip N of …"), 0-based. */
const singleOpensAt = async () => {
  await act(async () => {
    fireEvent.click(screen.getByLabelText('Single'))
  })
  await flush()
  const text = document.querySelector('.tray-count')!.textContent!
  return Number(text.match(/Clip ([\d,]+) of/)![1].replace(/,/g, '')) - 1
}

describe('Tray below 120 px', () => {
  let spy: jest.SpyInstance
  beforeEach(() => {
    jest.useFakeTimers()
    // No WebGL in jsdom: the GPU view uses its CPU renderer, drawing nowhere.
    const ctx2d = {
      createImageData: (w: number, h: number) => ({
        data: new Uint8ClampedArray(w * h * 4),
      }),
      putImageData: () => {},
      drawImage: () => {},
      fillRect: () => {},
      strokeRect: () => {},
    }
    spy = jest
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockImplementation(((kind: string) =>
        kind === '2d' ? ctx2d : null) as never)
  })
  afterEach(() => {
    spy.mockRestore()
    jest.useRealTimers()
  })

  it('builds no clip elements at 40-119 px; the grid comes back at 120', async () => {
    mockState.rows = 100_000
    render(<Harness results={100_000} />)
    await flush()
    expect(document.querySelector('.dom-layer')).toBeInTheDocument()
    expect(document.querySelectorAll('.clip').length).toBeGreaterThan(0)
    // 120 → 89 → 66 → 49 → 36 px: every step is the GPU view.
    for (let i = 0; i < 4; i += 1) {
      await clickZoom('Zoom out')
      expect(document.querySelector('.dom-layer')).not.toBeInTheDocument()
      expect(document.querySelector('.overview')).toBeInTheDocument()
      expect(document.querySelectorAll('.clip')).toHaveLength(0)
      // The whole tray is a handful of elements, whatever's on screen.
      expect(document.querySelectorAll('.tray-content *').length).toBeLessThan(
        20,
      )
    }
    for (let i = 0; i < 4; i += 1) await clickZoom('Zoom in')
    expect(document.querySelector('.dom-layer')).toBeInTheDocument()
    // The GPU view stays mounted, hidden, for the next crossing.
    expect(document.querySelector('.overview')).not.toBeVisible()
  })

  it('crossing 120 px and closing Single keep your place', async () => {
    mockState.rows = 100_000
    render(<Harness results={100_000} />)
    await flush()
    // The grid at 120 px: 6 px gaps, 126 px rows, 9 columns. Scroll to row 300.
    const grid = document.querySelector('.dom-layer') as HTMLElement
    await act(async () => {
      grid.scrollTop = 6 + 300 * 126
      fireEvent.scroll(grid)
    })
    await flush()
    // Out to the GPU view (the buttons keep the top row): clip 2700's row is at
    // the top there too.
    await clickZoom('Zoom out')
    const tile = 120 / 1.35
    const cols = Math.floor(W / tile)
    const topRow = Math.floor(2700 / cols)
    expect(await singleOpensAt()).toBe(topRow * cols)
    // Close Single: that clip is mid-screen in the GPU view, so the first clip
    // on screen is a few rows up.
    const centredFirst = (idx: number) =>
      Math.floor(((Math.floor(idx / cols) + 0.5) * tile - H / 2) / tile) * cols
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' })
    })
    await flush()
    const second = await singleOpensAt()
    expect(second).toBe(centredFirst(topRow * cols))
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' })
    })
    await flush()
    // Back in to the grid: it starts where the GPU view was (the buttons keep
    // the top row).
    const before = centredFirst(second)
    await clickZoom('Zoom in')
    const back = document.querySelector('.dom-layer') as HTMLElement
    expect(back).toBeInTheDocument()
    const firstRow = Math.floor((back.scrollTop - 6) / 126 + 1e-6)
    expect(firstRow).toBe(Math.floor(before / 9))
  })

  it('Ctrl+wheel in the grid keeps the clip under the cursor', async () => {
    mockState.rows = 100_000
    render(<Harness results={100_000} />)
    await flush()
    const grid = document.querySelector('.dom-layer') as HTMLElement
    await act(async () => {
      grid.scrollTop = 6 + 300 * 126
      fireEvent.scroll(grid)
    })
    await flush()
    // Under (300, 400): row 303, column 2.
    const under = 303 * 9 + 2
    await act(async () => {
      fireEvent.wheel(document.querySelector('.tray')!, {
        ctrlKey: true,
        deltaY: -100,
        clientX: 300,
        clientY: 400,
      })
    })
    await flush(50) // the zoom's frame
    await flush(300) // the window around the new screen
    const size = parseFloat(
      (document.querySelector('.clip') as HTMLElement).style.width,
    )
    expect(size).toBeGreaterThan(120)
    const gap = Math.max(2, Math.round(size * 0.05))
    const cell = size + gap
    const cols = Math.floor((W - gap) / cell)
    const row = Math.floor((grid.scrollTop + 400 - gap) / cell)
    expect(row).toBe(Math.floor(under / cols))
  })

  it('Select visible works in the GPU view', async () => {
    mockState.rows = 100_000
    render(<Harness results={100_000} />)
    await flush()
    await clickZoom('Zoom out')
    await clickZoom('Zoom out')
    await flush()
    await act(async () => {
      fireEvent.click(screen.getByText('Select visible'))
    })
    const tile = 120 / 1.35 / 1.35
    const cols = Math.floor(W / tile)
    const rows = Math.ceil(H / tile)
    expect(document.querySelector('.overview-status')!.textContent).toContain(
      `${(rows * cols).toLocaleString()} selected`,
    )
    expect(screen.getByText('Deselect visible')).toBeInTheDocument()
  })
})

describe('crossing 120 px keeps the GPU view', () => {
  let spy: jest.SpyInstance
  let select: jest.SpyInstance
  const calls = new Map<string, number>()
  let contexts = 0
  beforeEach(() => {
    jest.useFakeTimers()
    calls.clear()
    contexts = 0
    const log = { uniforms: new Map<string, number>(), layers: [] as number[] }
    spy = jest
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockImplementation(((kind: string) => {
        if (kind !== 'webgl2') return null
        contexts += 1
        // Count every call by name (texture uploads, deletes).
        const gl = fakeGl(log) as Record<string, unknown>
        return new Proxy(gl, {
          get: (t, k: string) => {
            const v = t[k]
            if (typeof v !== 'function') return v
            return (...a: unknown[]) => {
              calls.set(k, (calls.get(k) ?? 0) + 1)
              return (v as (..._a: unknown[]) => unknown)(...a)
            }
          },
        })
      }) as never)
    select = jest.spyOn(SelectionMask.prototype, 'select')
  })
  afterEach(() => {
    spy.mockRestore()
    select.mockRestore()
    jest.useRealTimers()
  })

  it('one WebGL context and one upload, whatever the crossings', async () => {
    mockState.rows = 100_000
    render(<Harness results={100_000} />)
    await flush()
    await clickZoom('Zoom out')
    await flush()
    expect(contexts).toBe(1)
    const uploads = calls.get('texSubImage2D') ?? 0
    const allocs = calls.get('texImage2D') ?? 0
    const marks = select.mock.calls.length
    expect(uploads).toBeGreaterThan(0)
    for (let i = 0; i < 3; i += 1) {
      await clickZoom('Zoom in')
      await flush()
      expect(document.querySelector('.dom-layer')).toBeInTheDocument()
      await clickZoom('Zoom out')
      await flush()
      expect(document.querySelector('.overview')).toBeVisible()
    }
    // Nothing new to upload or mark: the textures and marks were kept.
    expect(contexts).toBe(1)
    expect(calls.get('texSubImage2D') ?? 0).toBe(uploads)
    expect(calls.get('texImage2D') ?? 0).toBe(allocs)
    expect(calls.get('deleteTexture') ?? 0).toBe(0)
    expect(select.mock.calls.length).toBe(marks)
  })

  it('marks again once, on the way back, after a selection made in the grid', async () => {
    mockState.rows = 100_000
    render(<Harness results={100_000} />)
    await flush()
    await clickZoom('Zoom out')
    await flush()
    await clickZoom('Zoom in')
    await flush()
    const marks = select.mock.calls.length
    await act(async () => {
      fireEvent.click(screen.getByText('Select All'))
    })
    await act(async () => {
      fireEvent.click(screen.getByText('Deselect All'))
    })
    await act(async () => {
      fireEvent.click(screen.getByText('Select All'))
    })
    // Hidden: nothing marked while the grid shows.
    expect(select.mock.calls.length).toBe(marks)
    await clickZoom('Zoom out')
    await flush()
    expect(select.mock.calls.length).toBe(marks + 1)
  })

  it('a removal reads the overview again when main has done it', async () => {
    mockState.rows = 100_000
    render(<Harness results={100_000} />)
    await flush()
    await clickZoom('Zoom out')
    await clickZoom('Zoom out')
    await flush()
    await act(async () => {
      fireEvent.click(screen.getByText('Select visible'))
    })
    const reads = mockState.freshReads
    const ipc = jest.requireMock('../renderer/ipcBridge').default as Record<
      string,
      jest.Mock
    >
    ipc.removeResults.mockClear()
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Delete' })
    })
    await confirmRemove()
    await flush()
    expect(ipc.removeResults).toHaveBeenCalledTimes(1)
    // Main is still removing (5,000 rows at a time): no read yet.
    expect(mockState.freshReads).toBe(reads)
    await act(async () => {
      ipc.removeResults.mock.calls[0][1]({ removed: 10 })
    })
    await flush()
    expect(mockState.freshReads).toBe(reads + 1)
  })
})

/* -------------------------- the ring, pixel by pixel ------------------------- */

describe('kill / standout tones on the tiles', () => {
  // eslint-disable-next-line global-require
  const fs = require('fs') as typeof import('fs')
  // eslint-disable-next-line global-require
  const path = require('path') as typeof import('path')

  it('the same colours, alpha and width as the grid card (crossing 120 px)', () => {
    const css = fs.readFileSync(
      path.join(__dirname, '../renderer/components/Clip/Clip.css'),
      'utf8',
    )
    const ring = (tone: string) => {
      const m = css.match(
        new RegExp(
          `\\.clip--tone-${tone} \\.clip-accent \\{\\s*box-shadow: inset 0 0 0 ([\\d.]+)px rgba\\((\\d+), (\\d+), (\\d+), ([\\d.]+)\\)`,
        ),
      )!
      return { width: +m[1], rgb: [+m[2], +m[3], +m[4]], alpha: +m[5] }
    }
    for (const [tone, color] of [
      ['kill', CARD_LOOK.killColor],
      ['hot', CARD_LOOK.hotColor],
    ] as const) {
      const r = ring(tone)
      expect(r.width).toBe(CARD_LOOK.ringWidth)
      expect(r.alpha).toBe(CARD_LOOK.ringAlpha)
      expect(color.map((v) => Math.round(v * 255))).toEqual(r.rgb)
    }
  })

  it('the overview bytes: stage in the low 6 bits, tone in the top 2', () => {
    expect(stageOfByte(8 | (TONE_KILL << 6))).toBe(8)
    expect(toneOfByte(8 | (TONE_KILL << 6))).toBe(TONE_KILL)
    expect(toneOfByte(31 | (TONE_HOT << 6))).toBe(TONE_HOT)
    expect(stageOfByte(OVERVIEW_STAGE_NONE | (TONE_HOT << 6))).toBe(
      OVERVIEW_STAGE_NONE,
    )
    expect(toneOfByte(31)).toBe(0)
  })

  /** cpuDraw's picture of four clips in a row: kill, selected kill, hot, plain. */
  function draw(tileCss: number, dpr = 1) {
    const packed = new Uint8Array([
      ...[8 | (TONE_KILL << 6), 2, 9],
      ...[8 | (TONE_KILL << 6), 2, 9],
      ...[8 | (TONE_HOT << 6), 2, 9],
      ...[8, 2, 9],
    ])
    const tile = tileCss * dpr
    const w = Math.ceil(tile * 4)
    const h = Math.max(1, Math.ceil(tile))
    let out: Uint8ClampedArray | null = null
    const ctx = {
      createImageData: (iw: number, ih: number) => ({
        data: new Uint8ClampedArray(iw * ih * 4),
      }),
      putImageData: (img: { data: Uint8ClampedArray }) => {
        out = img.data
      },
    } as unknown as CanvasRenderingContext2D
    cpuDraw(
      ctx,
      {
        w,
        h,
        dpr,
        tile,
        gap: 0,
        scroll: 0,
        cols: 4,
        total: 4,
        loaded: 4,
        ...tileLook(tileCss),
        layout: 'arrow',
        hover: -1,
        rangeA: -1,
        rangeB: -1,
        invert: false,
      },
      { packed } as never,
      new Uint8Array([0, 1, 0, 0]),
      null,
    )
    const px = (x: number, y: number) => {
      const i = (y * w + x) * 4
      return [out![i], out![i + 1], out![i + 2]]
    }
    return { px, tile }
  }
  const reddish = ([r, g, b]: number[]) => r > 150 && r > g * 2 && r > b * 2
  const goldish = ([r, g, b]: number[]) => r > 150 && g > 110 && b < g * 0.6

  it('a thin ring at the edge from mid sizes down to 6 px; the selection wins', () => {
    for (const t of [85, 24, 8, 6]) {
      const { px, tile } = draw(t)
      const mid = Math.floor(tile / 2)
      // Kill: red edge pixel, the middle left alone.
      expect([t, reddish(px(0, mid))]).toEqual([t, true])
      expect([t, reddish(px(mid, mid))]).toEqual([t, false])
      expect(px(mid, mid)).toEqual(draw(t).px(Math.floor(tile * 3) + mid, mid))
      // Selected kill: no ring (the selection's look wins).
      expect([t, reddish(px(Math.floor(tile), mid))]).toEqual([t, false])
      // Hot: gold; plain: neither.
      expect([t, goldish(px(Math.floor(tile * 2), mid))]).toEqual([t, true])
      const plain = px(Math.floor(tile * 3), mid)
      expect([t, reddish(plain) || goldish(plain)]).toEqual([t, false])
    }
  })

  it('thicker on a high-DPI screen: 1.5 CSS px', () => {
    const { px, tile } = draw(40, 2)
    const mid = Math.floor(tile / 2)
    expect(reddish(px(0, mid))).toBe(true)
    expect(reddish(px(2, mid))).toBe(true)
    expect(reddish(px(4, mid))).toBe(false)
  })

  it('below ~6 px the whole tile is tinted, so kills show way out', () => {
    for (const t of [4, 2]) {
      const { px, tile } = draw(t)
      const mid = Math.floor(tile / 2)
      expect([t, reddish(px(mid, mid))]).toEqual([t, true])
      expect([t, goldish(px(Math.floor(tile * 2) + mid, mid))]).toEqual([
        t,
        true,
      ])
      expect([t, reddish(px(Math.floor(tile) + mid, mid))]).toEqual([t, false])
    }
  })
})
