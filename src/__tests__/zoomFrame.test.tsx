/**
 * Tray zoom input (tray-v2.md): any burst of wheel/pinch/slider/button input
 * commits at most one zoom per animation frame, from the live value, and wheel
 * deltas in lines or pages zoom like pixel ones. Counts, not timing.
 */
import '@testing-library/jest-dom'
import { act } from 'react'
import { fireEvent, render } from '@testing-library/react'
import OverviewCanvas from '../renderer/components/Tray/OverviewCanvas'
import { Selection } from '../lib/selection'
import {
  WHEEL_LINE_PX,
  WHEEL_ZOOM_MAX_PX,
  createZoomFrame,
  wheelDeltaPx,
  wheelZoomFactor,
} from '../renderer/lib/zoomFrame'

jest.mock('../renderer/ipcBridge', () => ({
  __esModule: true,
  default: {
    getOverviewChunk: (_req: unknown, cb: (_res: unknown) => void) =>
      cb({ ids: new Uint32Array(0), packed: new Uint8Array(0), next: null }),
  },
}))

// A hand-cranked animation frame.
const frames = () => {
  const queue = new Map<number, () => void>()
  let next = 1
  return {
    schedule: (cb: () => void) => {
      queue.set(next, cb)
      next += 1
      return next - 1
    },
    unschedule: (id: number) => {
      queue.delete(id)
    },
    pending: () => queue.size,
    run: () => {
      const cbs = [...queue.values()]
      queue.clear()
      cbs.forEach((cb) => cb())
    },
  }
}

const makeFrame = (initial = 100, min = 1, max = 300) => {
  const f = frames()
  const commit = jest.fn()
  const zoom = createZoomFrame({
    initial,
    clamp: (z) => Math.max(min, Math.min(max, z)),
    commit,
    schedule: f.schedule,
    unschedule: f.unschedule,
  })
  return { f, commit, zoom }
}

describe('createZoomFrame', () => {
  it('commits a burst of input once per frame, with every tick applied', () => {
    const { f, commit, zoom } = makeFrame()
    for (let i = 0; i < 120; i += 1) zoom.by(0.99)
    zoom.to(zoom.live() * 0.5)
    expect(commit).not.toHaveBeenCalled()
    expect(f.pending()).toBe(1)
    f.run()
    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit.mock.calls[0][0]).toBeCloseTo(100 * 0.99 ** 120 * 0.5, 9)
    // Nothing new: no frame, no commit.
    f.run()
    expect(commit).toHaveBeenCalledTimes(1)
  })

  it('zooms from the live value before the render catches up', () => {
    const { f, commit, zoom } = makeFrame()
    zoom.by(0.5)
    f.run()
    // The state has not rendered 50 yet; the next tick still starts from it.
    zoom.by(0.5)
    expect(zoom.live()).toBe(25)
    f.run()
    expect(commit.mock.calls.map((c) => c[0])).toEqual([50, 25])
  })

  it('clamps every step, and skips a frame that changes nothing', () => {
    const { f, commit, zoom } = makeFrame(2, 1, 300)
    for (let i = 0; i < 50; i += 1) zoom.by(0.5)
    expect(zoom.live()).toBe(1)
    f.run()
    expect(commit).toHaveBeenLastCalledWith(1)
    zoom.by(0.5)
    f.run()
    expect(commit).toHaveBeenCalledTimes(1)
    zoom.by(1e9)
    expect(zoom.live()).toBe(300)
    zoom.to(Number.NaN)
    expect(zoom.live()).toBe(300)
  })

  it('follows zooms set elsewhere, and cancel drops the waiting one', () => {
    const { f, commit, zoom } = makeFrame()
    zoom.by(0.5)
    zoom.cancel()
    expect(f.pending()).toBe(0)
    zoom.sync(250) // e.g. opening Single
    expect(zoom.live()).toBe(250)
    zoom.by(1.1)
    f.run()
    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit.mock.calls[0][0]).toBeCloseTo(275, 9)
  })
})

describe('wheel deltas', () => {
  it('normalises line and page mode', () => {
    expect(wheelDeltaPx({ deltaY: 100, deltaMode: 0 }, 900)).toBe(100)
    expect(wheelDeltaPx({ deltaY: 3, deltaMode: 1 }, 900)).toBe(
      3 * WHEEL_LINE_PX,
    )
    expect(wheelDeltaPx({ deltaY: 1, deltaMode: 2 }, 900)).toBe(900)
  })

  it('zooms one notch about the same in every mode', () => {
    const pixel = wheelZoomFactor({ deltaY: 100, deltaMode: 0 })
    const line = wheelZoomFactor({ deltaY: 3, deltaMode: 1 }) // Windows mouse
    const page = wheelZoomFactor({ deltaY: 1, deltaMode: 2 })
    expect(pixel).toBeCloseTo(0.78, 2)
    for (const f of [line, page]) {
      expect(f).toBeGreaterThan(0.65)
      expect(f).toBeLessThan(0.85)
    }
    // Up zooms in by the inverse.
    expect(wheelZoomFactor({ deltaY: -100, deltaMode: 0 })).toBeCloseTo(
      1 / pixel,
      9,
    )
  })

  it('keeps pinches fine-grained and caps runaway deltas', () => {
    // Trackpad pinch: ctrlKey wheel events with small pixel deltas.
    const pinch = wheelZoomFactor({ deltaY: 2, deltaMode: 0 })
    expect(pinch).toBeLessThan(1)
    expect(pinch).toBeGreaterThan(0.99)
    const huge = wheelZoomFactor({ deltaY: 5000, deltaMode: 0 })
    expect(huge).toBeCloseTo(
      wheelZoomFactor({ deltaY: WHEEL_ZOOM_MAX_PX, deltaMode: 0 }),
      9,
    )
    expect(wheelZoomFactor({ deltaY: 50, deltaMode: 1 })).toBe(huge)
  })
})

describe('OverviewCanvas wheel', () => {
  const canvasAt = (tile: number, onZoom: (_factor: number) => void) => (
    <OverviewCanvas
      filterId="zoom-frame-test"
      dataVersion="1"
      total={1_000_000}
      tile={tile}
      width={1600}
      height={900}
      selection={Selection.none()}
      onSelectionChange={() => {}}
      onZoom={onZoom}
    />
  )

  it('attaches once and sends factors, not sizes from a stale tile', async () => {
    // No WebGL or 2D context in jsdom: the view shows its "can't draw" state.
    const ctx = jest
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue(null)
    // The wheel listener is on the view's root, so it works over hover buttons.
    const add = jest.spyOn(HTMLDivElement.prototype, 'addEventListener')
    const onZoom = jest.fn()
    let view!: ReturnType<typeof render>
    await act(async () => {
      view = render(canvasAt(4, onZoom))
    })
    const wheels = () =>
      add.mock.calls.filter(
        (c, i) =>
          c[0] === 'wheel' &&
          (add.mock.contexts[i] as HTMLElement).classList.contains('overview'),
      ).length
    expect(wheels()).toBe(1)
    for (const tile of [3, 2, 1, 0.5]) view.rerender(canvasAt(tile, onZoom))
    expect(wheels()).toBe(1)

    const canvas = view.container.querySelector('canvas')!
    fireEvent.wheel(canvas, { deltaY: 100, deltaMode: 0, ctrlKey: true })
    fireEvent.wheel(canvas, { deltaY: 3, deltaMode: 1, ctrlKey: true })
    expect(onZoom).toHaveBeenCalledTimes(2)
    expect(onZoom.mock.calls[0][0]).toBeCloseTo(
      wheelZoomFactor({ deltaY: 100, deltaMode: 0 }),
      9,
    )
    expect(onZoom.mock.calls[1][0]).toBeCloseTo(
      wheelZoomFactor({ deltaY: 3, deltaMode: 1 }),
      9,
    )
    // A plain wheel scrolls; it does not zoom.
    fireEvent.wheel(canvas, { deltaY: 100, deltaMode: 0 })
    expect(onZoom).toHaveBeenCalledTimes(2)
    add.mockRestore()
    ctx.mockRestore()
  })
})
