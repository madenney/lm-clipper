/**
 * @jest-environment node
 *
 * The tray's window reads by position (main/rowSeek.ts) against a table kept as a
 * sorted array: the same rows as LIMIT/OFFSET, and how many key steps each read
 * costs (deep positions are walked once, then reached in at most one step).
 * The SQLite side is checked for real in scripts/worker-check/seek.js.
 */
import {
  PositionIndex,
  STOPPED,
  STRIDE,
  WindowCache,
  readThroughIndex,
  type SeekKey,
  type SeekSource,
} from '../main/rowSeek'

type Row = { id: number; k: number }

/** A table in tray order (k, id), counting the work the index asks of it. */
function arraySource(table: Row[]) {
  const cmp = (a: SeekKey, b: SeekKey) => a.k - b.k || a.id - b.id
  const sorted = [...table].sort(cmp)
  const start = (from: SeekKey | null) => {
    if (!from) return 0
    const i = sorted.findIndex((r) => cmp(r, from) >= 0)
    return i < 0 ? sorted.length : i
  }
  const stats = { keySteps: 0, rowReads: 0 }
  const source: SeekSource = {
    keyAt(from, skip) {
      stats.keySteps += 1
      const r = sorted[start(from) + skip]
      return r ? { k: r.k, id: r.id } : null
    },
    rows(from, skip, limit) {
      stats.rowReads += 1
      const i = start(from) + skip
      return sorted.slice(i, i + limit)
    },
  }
  /** What `ORDER BY k, id LIMIT limit OFFSET offset` returns. */
  const byOffset = (offset: number, limit: number) =>
    sorted.slice(offset, offset + limit)
  return { source, stats, byOffset, length: sorted.length }
}

/** Ids 1..n with some removed (gaps), in id order or a custom order with ties. */
function makeTable(n: number, customSort: boolean): Row[] {
  const rows: Row[] = []
  for (let id = 1; id <= n; id += 1) {
    if (id % 37 === 0 || (id > 2000 && id < 2600)) continue
    rows.push({ id, k: customSort && id % 3 === 0 ? (id * 7919) % 400 : id })
  }
  return rows
}

describe('rowSeek: window reads by position', () => {
  it.each([
    ['ids with gaps', false],
    ['a custom sort with ties', true],
  ])('reads exactly the OFFSET rows (%s)', (_label, customSort) => {
    const t = arraySource(makeTable(12_000, customSort as boolean))
    const index = new PositionIndex()
    const n = t.length
    const offsets = [
      0,
      1,
      STRIDE - 1,
      STRIDE,
      STRIDE + 1,
      5000,
      n - 1,
      n,
      n + 9,
    ]
    for (let i = 0; i < 40; i += 1)
      offsets.push(((i * 2654435761) >>> 0) % (n + 50))
    for (const offset of offsets)
      for (const limit of [1, 7, 2000])
        expect(readThroughIndex(index, t.source, offset, limit)).toEqual(
          t.byOffset(offset, limit),
        )
  })

  it('walks to a deep position once; later reads take at most one step', () => {
    const t = arraySource(makeTable(60_000, false))
    const index = new PositionIndex()
    const deep = t.length - 2000
    readThroughIndex(index, t.source, deep, 2000)
    // One key step per stride from the start, never per row.
    expect(t.stats.keySteps).toBe(Math.floor(deep / STRIDE))

    t.stats.keySteps = 0
    for (let i = 0; i < 100; i += 1) {
      const offset = ((i * 2654435761) >>> 0) % deep
      expect(readThroughIndex(index, t.source, offset, 300)).toEqual(
        t.byOffset(offset, 300),
      )
    }
    expect(t.stats.keySteps).toBe(0)
    // Just past what's known: one more step.
    readThroughIndex(index, t.source, deep + STRIDE, 10)
    expect(t.stats.keySteps).toBeLessThanOrEqual(1)
  })

  it('reads the start without any key steps', () => {
    const t = arraySource(makeTable(5000, false))
    const index = new PositionIndex()
    expect(readThroughIndex(index, t.source, 0, 2000)).toEqual(
      t.byOffset(0, 2000),
    )
    expect(readThroughIndex(index, t.source, STRIDE - 5, 4)).toEqual(
      t.byOffset(STRIDE - 5, 4),
    )
    expect(t.stats.keySteps).toBe(0)
  })

  it('past the end: no rows, and the end is remembered', () => {
    const t = arraySource(makeTable(3000, false))
    const index = new PositionIndex()
    expect(readThroughIndex(index, t.source, 50_000, 10)).toEqual([])
    const steps = t.stats.keySteps
    expect(readThroughIndex(index, t.source, 90_000, 10)).toEqual([])
    expect(t.stats.keySteps).toBe(steps)
    expect(index.known).toBe(Infinity)
    expect(readThroughIndex(index, t.source, 0, 0)).toEqual([])
    expect(readThroughIndex(index, t.source, -1, 10)).toEqual([])
  })

  it('stops when told to and keeps what it found', () => {
    const t = arraySource(makeTable(40_000, false))
    const index = new PositionIndex()
    let calls = 0
    const target = 30 * STRIDE
    expect(
      readThroughIndex(index, t.source, target, 10, () => {
        calls += 1
        return calls > 5
      }),
    ).toBeNull()
    expect(t.stats.rowReads).toBe(0)
    expect(t.stats.keySteps).toBe(5)
    expect(index.known).toBe(6 * STRIDE)
    expect(index.locate(target, t.source, () => true)).toBe(STOPPED)
    // The next read goes on from there (30 strides in all, not 35).
    expect(readThroughIndex(index, t.source, target, 10)).toEqual(
      t.byOffset(target, 10),
    )
    expect(t.stats.keySteps).toBe(30)
  })
})

describe('rowSeek: WindowCache', () => {
  it('keeps an index while the database is unchanged', () => {
    const cache = new WindowCache()
    const a = cache.index('t', false, 1)
    expect(cache.index('t', false, 1)).toBe(a)
    // A custom sort is a different order: its own index.
    expect(cache.index('t', true, 1)).not.toBe(a)
  })

  it('drops every index when another connection has written', () => {
    const cache = new WindowCache()
    const a = cache.index('t', false, 1)
    const b = cache.index('u', false, 1)
    expect(cache.index('t', false, 2)).not.toBe(a)
    expect(cache.index('u', false, 2)).not.toBe(b)
  })

  it('keeps a few tables, dropping the least recently read', () => {
    const cache = new WindowCache(2)
    const a = cache.index('a', false, 1)
    const b = cache.index('b', false, 1)
    cache.index('a', false, 1) // a is now the most recent
    cache.index('c', false, 1)
    expect(cache.index('a', false, 1)).toBe(a)
    expect(cache.index('b', false, 1)).not.toBe(b)
  })
})
