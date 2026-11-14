/**
 * The GPU view's hover Play / Record buttons (components/Tray/OverviewCanvas.tsx,
 * lib/overviewButtons.ts): placed over the hovered tile, built from the fetched
 * row, and not mistaken for clicks on the tile.
 */
import '@testing-library/jest-dom'
import { act } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import OverviewCanvas from '../renderer/components/Tray/OverviewCanvas'
import { tileButtonsGeometry, MIN_BTN } from '../renderer/lib/overviewButtons'
import { clipDisplayConfig } from '../renderer/config/clipDisplay'
import { Selection } from '../lib/selection'

const row = {
  id: 'clip-3',
  path: '/replays/a.slp',
  startFrame: 100,
  endFrame: 400,
  lastFrame: 5000,
  stage: 31,
  players: [],
}
const getResults = jest.fn((_req: unknown, cb: (_res: unknown) => void) =>
  cb({ items: [row] }),
)
jest.mock('../renderer/ipcBridge', () => ({
  __esModule: true,
  default: {
    getOverviewChunk: (_req: unknown, cb: (_res: unknown) => void) =>
      cb({
        ids: new Uint32Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
        packed: new Uint8Array(30),
        next: null,
      }),
    getResults: (req: unknown, cb: (_res: unknown) => void) =>
      getResults(req, cb),
  },
}))
jest.mock('../renderer/lib/tileArt', () => ({
  ...jest.requireActual('../renderer/lib/tileArt'),
  tileArtNow: () => null,
  loadTileArt: () => new Promise(() => {}),
}))

const ctx2d = {
  createImageData: (w: number, h: number) => ({
    data: new Uint8ClampedArray(w * h * 4),
  }),
  putImageData: () => {},
  drawImage: () => {},
  fillRect: () => {},
  strokeRect: () => {},
}

describe('tileButtonsGeometry', () => {
  it('sits on the hovered tile, scaled, with clickable buttons at 40 px', () => {
    // tile 50, 8 columns: index 9 = row 1, col 1; scrolled 20 px.
    const g = tileButtonsGeometry(9, 8, 50, 20, 1)
    expect(g.left).toBeCloseTo(50 + 3, 5)
    expect(g.top).toBeCloseTo(50 - 20 + 3, 5)
    expect(g.size).toBeCloseTo(47, 5)
    expect(g.btn).toBeGreaterThanOrEqual(MIN_BTN)
    // Both buttons fit inside the tile.
    expect(g.right + 2 * g.btn + g.gap).toBeLessThan(g.size)
    expect(g.bottom + g.btn).toBeLessThan(g.size)
    const tiny = tileButtonsGeometry(0, 8, 40, 0, 1)
    expect(tiny.btn).toBe(MIN_BTN)
    expect(tiny.right + 2 * tiny.btn + tiny.gap).toBeLessThan(tiny.size)
  })

  it('matches the 120 px card (24 px buttons, 6 px in) so crossing does not jump', () => {
    const g = tileButtonsGeometry(0, 4, 120, 0, 1)
    expect(g.btn).toBe(24)
    expect(g.right).toBe(6)
    expect(g.gap).toBe(5)
    expect(clipDisplayConfig.features.gpuButtons.minSize).toBeLessThanOrEqual(
      40,
    )
  })
})

describe('the hover buttons in the GPU view', () => {
  const onSelectionChange = jest.fn()
  const onOpen = jest.fn()
  const onClipPlay = jest.fn()
  const onClipRecord = jest.fn()
  beforeEach(() => {
    jest
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockImplementation(((kind: string) =>
        kind === '2d' ? ctx2d : null) as never)
    jest.spyOn(console, 'warn').mockImplementation(() => {})
    getResults.mockClear()
    jest.clearAllMocks()
  })
  afterEach(() => jest.restoreAllMocks())

  const hoverTile = async (tile: number) => {
    await act(async () => {
      render(
        <OverviewCanvas
          filterId="t"
          dataVersion="1"
          total={10}
          tile={tile}
          width={400}
          height={300}
          selection={Selection.none()}
          onSelectionChange={onSelectionChange}
          onZoom={() => {}}
          onOpen={onOpen}
          onClipPlay={onClipPlay}
          onClipRecord={onClipRecord}
        />,
      )
    })
    const canvas = document.querySelector('canvas')!
    canvas.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 400, height: 300 }) as DOMRect
    // The middle of tile index 2 (third column).
    fireEvent.mouseMove(canvas, { clientX: tile * 2 + 10, clientY: 10 })
    return canvas
  }

  it('shows Play / Record over the tile, with the card payload once the row is in', async () => {
    await hoverTile(50)
    const overlay = await screen.findByTestId('overview-btns')
    expect(parseFloat(overlay.style.left)).toBeCloseTo(103, 0)
    const play = screen.getByLabelText('Play clip')
    const record = screen.getByLabelText('Record clip')
    await waitFor(() => expect(play).toBeEnabled())
    fireEvent.click(play)
    expect(onClipPlay).toHaveBeenCalledWith({
      path: '/replays/a.slp',
      startFrame: 100,
      endFrame: 400,
      lastFrame: 5000,
    })
    fireEvent.click(record)
    expect(onClipRecord).toHaveBeenCalledWith('clip-3')
  })

  it('is disabled until the row has arrived', async () => {
    getResults.mockImplementation(() => {})
    await hoverTile(50)
    await screen.findByTestId('overview-btns')
    expect(screen.getByLabelText('Play clip')).toBeDisabled()
    expect(screen.getByLabelText('Record clip')).toBeDisabled()
    getResults.mockImplementation((_r, cb) => cb({ items: [row] }))
  })

  it('a click on a button neither selects nor opens the tile; below the minimum there are no buttons', async () => {
    await hoverTile(50)
    const play = await screen.findByLabelText('Play clip')
    await waitFor(() => expect(play).toBeEnabled())
    fireEvent.mouseDown(play)
    fireEvent.mouseUp(play)
    fireEvent.click(play)
    fireEvent.doubleClick(play)
    expect(onSelectionChange).not.toHaveBeenCalled()
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('shows nothing under the minimum size', async () => {
    await hoverTile(30)
    expect(screen.queryByTestId('overview-btns')).toBeNull()
  })

  it('stays hovered when the pointer moves onto a button', async () => {
    const canvas = await hoverTile(50)
    const play = await screen.findByLabelText('Play clip')
    fireEvent.mouseLeave(canvas, { relatedTarget: play })
    expect(screen.queryByTestId('overview-btns')).not.toBeNull()
    fireEvent.mouseLeave(canvas, { relatedTarget: document.body })
    expect(screen.queryByTestId('overview-btns')).toBeNull()
  })
})
