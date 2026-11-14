/**
 * The GPU view's CPU fallback (components/Tray/OverviewCanvas.tsx): when WebGL2
 * gets a context but the shader won't compile, or a lost context never comes
 * back, the view draws on the CPU. A canvas that has had a WebGL context can't
 * give a 2D one, so it must swap in a fresh canvas (it used to say "This
 * computer can't draw the overview" instead). One case per file: the "WebGL is
 * broken" flag lasts the session (overviewContextLost.test.tsx has the other).
 */
import '@testing-library/jest-dom'
import { act } from 'react'
import { render } from '@testing-library/react'
import OverviewCanvas from '../renderer/components/Tray/OverviewCanvas'
import { Selection } from '../lib/selection'

jest.mock('../renderer/ipcBridge', () => ({
  __esModule: true,
  default: {
    getOverviewChunk: (_req: unknown, cb: (_res: unknown) => void) =>
      cb({ ids: new Uint32Array(10), packed: new Uint8Array(30), next: null }),
  },
}))
jest.mock('../renderer/lib/tileArt', () => ({
  ...jest.requireActual('../renderer/lib/tileArt'),
  tileArtNow: () => null,
  loadTileArt: () => new Promise(() => {}),
}))

/** WebGL2 that works, or whose shaders never compile. */
const fakeGl = (compiles: boolean, made: string[]) =>
  new Proxy(
    {
      getParameter: () => 4096,
      getShaderParameter: () => compiles,
      getProgramParameter: () => true,
      getShaderInfoLog: () => 'ANGLE: compile failed',
      getUniformLocation: () => ({}),
      isContextLost: () => false,
      createShader: () => {
        made.push('shader')
        return {}
      },
      deleteShader: () => made.push('-shader'),
      createProgram: () => {
        made.push('program')
        return {}
      },
      deleteProgram: () => made.push('-program'),
      getExtension: () => ({ loseContext: () => made.push('lost') }),
    } as Record<string, unknown>,
    {
      get: (t, k: string) =>
        k in t ? t[k] : /^[A-Z_0-9]+$/.test(k) ? 1 : () => ({}),
    },
  )

const ctx2d = {
  createImageData: (w: number, h: number) => ({
    data: new Uint8ClampedArray(w * h * 4),
  }),
  putImageData: () => {},
  drawImage: () => {},
  fillRect: () => {},
  strokeRect: () => {},
}

let spy: jest.SpyInstance
let made: string[] = []
/** Like a browser: a canvas that gave out a WebGL context gives no 2D one. */
function mockCanvases(compiles: boolean) {
  const kinds = new WeakMap<HTMLCanvasElement, string>()
  spy = jest
    .spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockImplementation(function getContext(
      this: HTMLCanvasElement,
      kind: string,
    ) {
      const had = kinds.get(this)
      if (had && had !== kind) return null
      kinds.set(this, kind)
      return kind === 'webgl2' ? fakeGl(compiles, made) : ctx2d
    } as never)
}

const view = () => (
  <OverviewCanvas
    filterId="t"
    dataVersion="1"
    total={10}
    tile={20}
    width={400}
    height={300}
    selection={Selection.none()}
    onSelectionChange={() => {}}
    onZoom={() => {}}
  />
)
const status = () => document.querySelector('.overview-status')!.textContent

beforeEach(() => {
  made = []
  jest.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  spy.mockRestore()
  jest.restoreAllMocks()
  jest.useRealTimers()
})

describe('the GPU view without working WebGL2', () => {
  it('shaders that fail to compile: frees what it made, then draws on the CPU on a fresh canvas', async () => {
    mockCanvases(false)
    await act(async () => {
      render(view())
    })
    expect(status()).toContain('basic graphics')
    expect(status()).not.toContain('can’t draw')
    // The failed shader and program were deleted and the context let go.
    expect(made).toContain('-shader')
    expect(made).toContain('-program')
    expect(made).toContain('lost')
  })
})
