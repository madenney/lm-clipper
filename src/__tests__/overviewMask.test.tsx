/**
 * The far-out view's selection mask and GPU lifetime (tray-v2.md): overview
 * chunks mark and upload only their own rows, selection changes made in the view
 * touch only the rows they change, an unmounted view gives its WebGL context
 * back, and Select All is the shader's inverted marks (the rows left out), not
 * a mark per row. Counts, not timing.
 */
import '@testing-library/jest-dom'
import { act } from 'react'
import { render } from '@testing-library/react'
import { SelectionMask } from '../renderer/lib/overviewMask'
import { Selection } from '../lib/selection'
import OverviewCanvas from '../renderer/components/Tray/OverviewCanvas'

// Overview chunks arrive when the test says so.
const chunkQueue: (() => void)[] = []
let chunkRows = 1000
jest.mock('../renderer/ipcBridge', () => ({
  __esModule: true,
  default: {
    getOverviewChunk: (
      req: { cursor: { key: number; id: number } | null },
      cb: (_res: unknown) => void,
    ) => {
      chunkQueue.push(() => {
        const from = req.cursor ? req.cursor.id : 0
        const n = Math.min(chunkRows, TOTAL - from)
        const ids = new Uint32Array(n).map((_, i) => from + i + 1)
        const last = from + n
        cb({
          ids,
          packed: new Uint8Array(n * 3),
          next: last < TOTAL ? { key: last, id: last } : null,
        })
      })
    },
  },
}))
const TOTAL = 3000

/** A brute-force mask: 1 where the id is marked (selected, or with Select All left out). */
const expected = (ids: Uint32Array, count: number, sel: Set<string>) => {
  const out = new Uint8Array(ids.length)
  for (let i = 0; i < count; i += 1) if (sel.has(String(ids[i]))) out[i] = 1
  return out
}
const of = (sel: Set<string>) => Selection.of(sel)

describe('SelectionMask', () => {
  const N = 64 * 50
  const ids = new Uint32Array(N).map((_, i) => i * 7 + 3)
  const idAt = (i: number) => String(ids[i])

  it('marks and dirties only the rows of each new chunk', () => {
    const m = new SelectionMask()
    m.attach('data', N)
    m.select(ids, 0, of(new Set([idAt(10), idAt(700), idAt(2000)])))
    m.takeDirtyRows(64, 50) // the fresh mask's first upload
    // Chunk 1 (rows 0..999) holds two selected clips: rows 0 and 10 of the texture.
    m.extend(ids, 1000)
    expect(m.takeDirtyRows(64, 50)).toEqual([0, 11])
    // Chunk 2 (1000..1999) holds none: nothing to upload.
    m.extend(ids, 2000)
    expect(m.takeDirtyRows(64, 50)).toBeNull()
    // Chunk 3: just the texture row holding row 2000.
    m.extend(ids, N)
    expect(m.takeDirtyRows(64, 50)).toEqual([31, 32])
    expect(m.mask).toEqual(
      expected(ids, N, new Set([idAt(10), idAt(700), idAt(2000)])),
    )
  })

  it('with nothing selected, chunks upload nothing', () => {
    const m = new SelectionMask()
    m.attach('data', N)
    m.select(ids, 0, Selection.none())
    m.takeDirtyRows(64, 50)
    for (let c = 500; c <= N; c += 500) {
      expect(m.extend(ids, c)).toBe(false)
      expect(m.takeDirtyRows(64, 50)).toBeNull()
    }
  })

  it('a click re-marks only the rows it touched', () => {
    const m = new SelectionMask()
    m.attach('data', N)
    m.select(ids, N, of(new Set([idAt(1000)])))
    m.takeDirtyRows(64, 50)
    // Ctrl-click row 1200: one texture row.
    const two = new Set([idAt(1000), idAt(1200)])
    m.select(ids, N, of(two), { lo: 1200, hi: 1200, keep: true })
    expect(m.takeDirtyRows(64, 50)).toEqual([18, 19])
    expect(m.mask).toEqual(expected(ids, N, two))
    // Plain click row 1300: clears the old marks' band and marks the new one.
    const one = new Set([idAt(1300)])
    m.select(ids, N, of(one), { lo: 1300, hi: 1300, keep: false })
    expect(m.takeDirtyRows(64, 50)).toEqual([15, 21])
    expect(m.mask).toEqual(expected(ids, N, one))
    // Clearing touches only the band that held marks.
    m.select(ids, N, Selection.none())
    expect(m.takeDirtyRows(64, 50)).toEqual([20, 21])
    expect(m.mask.every((v) => v === 0)).toBe(true)
  })

  it('matches a full rebuild through any mix of changes and chunks', () => {
    let seed = 7
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31
      return seed % n
    }
    const m = new SelectionMask()
    m.attach('data', N)
    let sel = new Set<string>()
    let count = 0
    m.select(ids, count, of(sel))
    for (let step = 0; step < 300; step += 1) {
      const op = rand(6)
      if (op === 0 && count < N) {
        count = Math.min(N, count + 1 + rand(400))
        m.extend(ids, count)
      } else if (count > 0) {
        const a = rand(count)
        const b = Math.min(count - 1, a + rand(60))
        let next: Set<string>
        let hint = null
        if (op === 1) {
          next = new Set(sel)
          if (next.has(idAt(a))) next.delete(idAt(a))
          else next.add(idAt(a))
          hint = { lo: a, hi: a, keep: true }
        } else if (op === 2 || op === 3) {
          next = op === 2 ? new Set(sel) : new Set()
          for (let i = a; i <= b; i += 1) next.add(idAt(i))
          hint = { lo: a, hi: b, keep: op === 2 }
        } else if (op === 4) {
          // A change from elsewhere (the grid): no hint.
          next = new Set([idAt(rand(N)), idAt(rand(N))])
        } else {
          next = new Set()
        }
        const all = rand(10) === 0
        m.select(ids, count, all ? Selection.everything(N) : of(next), hint)
        // Select All is the shader's inverted marks: the mask is empty, and the
        // next change (even one with a hint) starts over.
        sel = all ? new Set() : next
      }
      const want = expected(ids, count, sel)
      let wrong = 0
      for (let i = 0; i < N; i += 1) if (m.mask[i] !== want[i]) wrong += 1
      expect(wrong).toBe(0)
    }
  })

  it('a new overview starts fresh and uploads all of it', () => {
    const m = new SelectionMask()
    m.attach('a', N)
    m.select(ids, N, of(new Set([idAt(5)])))
    m.takeDirtyRows(64, 50)
    m.attach('b', N)
    expect(m.takeDirtyRows(64, 50)).toEqual([0, 50])
    expect(m.mask.every((v) => v === 0)).toBe(true)
    // The selection is kept and marked again as the new rows arrive.
    m.extend(ids, N)
    expect(m.mask[5]).toBe(1)
  })
})

describe('SelectionMask with Select All', () => {
  const N = 64 * 50
  const ids = new Uint32Array(N).map((_, i) => i * 7 + 3)

  it('marks only the rows left out, and inverts', () => {
    const m = new SelectionMask()
    m.attach('data', N)
    // Everything: no marks at all, whatever the size.
    m.select(ids, N, Selection.everything(N))
    expect(m.invert).toBe(true)
    expect(m.mask.every((v) => v === 0)).toBe(true)
    m.takeDirtyRows(64, 50)
    // Ctrl-click row 900 out: one mark, one texture row.
    const out = Selection.everything(N).toggle(ids[900])
    m.select(ids, N, out, { lo: 900, hi: 900, keep: true })
    expect(m.takeDirtyRows(64, 50)).toEqual([14, 15])
    expect(m.mask.reduce((a, v) => a + v, 0)).toBe(1)
    expect(m.mask[900]).toBe(1)
    // Back to a plain selection: marks are the selected rows again.
    m.select(ids, N, Selection.of([ids[3]]))
    expect(m.invert).toBe(false)
    expect(m.mask[900]).toBe(0)
    expect(m.mask[3]).toBe(1)
  })
})

/* A recording WebGL2 stand-in: just enough for OverviewCanvas. */
const fakeGl = (log: { sel: number[][]; deleted: string[]; lost: number }) => {
  const TEXTURE0 = 0x84c0
  let unit = 0
  let lost = false
  const gl: Record<string, unknown> = {
    TEXTURE0,
    TEXTURE1: TEXTURE0 + 1,
    TEXTURE2: TEXTURE0 + 2,
    MAX_TEXTURE_SIZE: 0x0d33,
    COMPILE_STATUS: 1,
    LINK_STATUS: 2,
    getParameter: (p: number) => (p === 0x0d33 ? 64 : 0),
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    createShader: () => ({}),
    createProgram: () => ({}),
    createBuffer: () => ({}),
    createTexture: () => ({}),
    activeTexture: (u: number) => {
      unit = u - TEXTURE0
    },
    texSubImage2D: (...a: unknown[]) => {
      // Unit 1 is the selection: [first texture row, rows].
      if (unit === 1) log.sel.push([a[3] as number, a[5] as number])
    },
    deleteTexture: () => log.deleted.push('texture'),
    deleteBuffer: () => log.deleted.push('buffer'),
    deleteShader: () => log.deleted.push('shader'),
    deleteProgram: () => log.deleted.push('program'),
    isContextLost: () => lost,
    getExtension: (name: string) =>
      name === 'WEBGL_lose_context'
        ? {
            loseContext: () => {
              lost = true
              log.lost += 1
            },
          }
        : null,
  }
  return new Proxy(gl, {
    get: (t, k: string) =>
      k in t ? t[k] : /^[A-Z_0-9]+$/.test(k) ? 1 : () => null,
  })
}

describe('OverviewCanvas GPU', () => {
  let log: { sel: number[][]; deleted: string[]; lost: number }
  let spy: jest.SpyInstance
  beforeEach(() => {
    jest.useFakeTimers()
    chunkQueue.length = 0
    log = { sel: [], deleted: [], lost: 0 }
    const contexts = new WeakMap<HTMLCanvasElement, unknown>()
    spy = jest
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockImplementation(function getContext(
        this: HTMLCanvasElement,
        kind: string,
      ) {
        if (kind !== 'webgl2') return { drawImage: () => {} } as never
        if (!contexts.has(this)) contexts.set(this, fakeGl(log))
        return contexts.get(this) as never
      })
    // A GPU with 64x64 textures: 64 clips per texture row.
    ;(window as unknown as { __LUNAR_MAX_TEX__?: number }).__LUNAR_MAX_TEX__ =
      64
  })
  afterEach(() => {
    spy.mockRestore()
    jest.useRealTimers()
    delete (window as unknown as { __LUNAR_MAX_TEX__?: number })
      .__LUNAR_MAX_TEX__
  })

  const view = (key: string, selected: Selection) => (
    <OverviewCanvas
      filterId={key}
      dataVersion="1"
      total={TOTAL}
      tile={8}
      width={800}
      height={600}
      selection={selected}
      onSelectionChange={() => {}}
      onZoom={() => {}}
    />
  )

  it('uploads only the texture rows a chunk marked', async () => {
    chunkRows = 1000
    // Selected: ids 11 (row 10) and 2501 (row 2500).
    await act(async () => {
      render(view('chunks', Selection.of(['11', '2501'])))
    })
    const first = log.sel.length
    expect(first).toBeGreaterThan(0) // the fresh texture, once
    for (let c = 0; c < 3; c += 1)
      await act(async () => {
        chunkQueue.shift()!()
      })
    // Chunk 1 uploads texture row 0 (row 10); chunk 2 nothing; chunk 3 row 39.
    expect(log.sel.slice(first)).toEqual([
      [0, 1],
      [39, 1],
    ])
  })

  it('gives the WebGL context back every time it unmounts', async () => {
    for (let i = 0; i < 30; i += 1) {
      let v!: ReturnType<typeof render>
      await act(async () => {
        v = render(view(`mount-${i}`, Selection.none()))
      })
      v.unmount()
      jest.runOnlyPendingTimers()
    }
    expect(log.lost).toBe(30)
    // Data, selection, icons and stage art: four textures a mount.
    expect(log.deleted.filter((d) => d === 'texture')).toHaveLength(120)
    expect(log.deleted.filter((d) => d === 'program')).toHaveLength(30)
  })
})
