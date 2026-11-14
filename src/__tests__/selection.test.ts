/**
 * @jest-environment node
 *
 * The tray's selection model (lib/selection.ts): "these rows" or "every row
 * except these", as bits by row id. Checked against a plain Set model through
 * random edits, plus the sizes that matter at 21M rows (Select All holds no ids;
 * a range of millions is bits, not a list). Counts, not timing.
 */
import { IdBits, Selection } from '../lib/selection'

/** The reference: the same selection as a Set of selected ids over a table. */
class Model {
  table: number[]

  selected = new Set<number>()

  constructor(table: number[]) {
    this.table = table
  }

  count() {
    return this.table.filter((id) => this.selected.has(id)).length
  }
}

const rng = (seed: number) => () => {
  seed = (seed * 1103515245 + 12345) % 2 ** 31
  return seed / 2 ** 31
}

describe('IdBits', () => {
  it('sets, clears and counts ids across pages', () => {
    const b = new IdBits()
    for (const id of [0, 1, 31, 32, 65535, 65536, 1e7, 2 ** 32 - 1])
      expect(b.set(id, true)).toBe(true)
    expect(b.set(31, true)).toBe(false) // already set
    expect(b.size).toBe(8)
    expect(b.has(65536)).toBe(true)
    expect(b.has(65537)).toBe(false)
    expect(b.set(65536, false)).toBe(true)
    expect(b.set(65536, false)).toBe(false)
    expect(b.size).toBe(7)
    // Not row ids: ignored.
    for (const bad of [-1, 1.5, NaN, Infinity]) {
      expect(b.set(bad, true)).toBe(false)
      expect(b.has(bad)).toBe(false)
    }
    expect(b.size).toBe(7)
  })

  it('lists ids as ascending runs, full words included', () => {
    const b = new IdBits()
    const want: [number, number][] = [
      [3, 3],
      [5, 100], // spans full 32-bit words
      [65530, 65545], // across a page boundary
      [200000, 200000],
    ]
    for (const [lo, hi] of want)
      for (let i = lo; i <= hi; i += 1) b.set(i, true)
    const runs: [number, number][] = []
    b.forEachRun((lo, hi) => runs.push([lo, hi]))
    expect(runs).toEqual(want)
    expect(b.toArray(4)).toEqual([3, 5, 6, 7])
    expect(b.toArray().length).toBe(b.size)
  })

  it('copies share pages until one is written', () => {
    const a = new IdBits()
    a.set(10, true)
    const c = a.copy()
    c.set(11, true)
    c.set(10, false)
    expect(a.has(10)).toBe(true)
    expect(a.has(11)).toBe(false)
    expect(c.has(10)).toBe(false)
    expect(c.has(11)).toBe(true)
    expect([a.size, c.size]).toEqual([1, 1])
  })

  it('packs to its non-empty pages and back', () => {
    const b = new IdBits()
    b.set(5, true)
    b.set(70000, true)
    b.set(70000, false) // its page is empty now: not sent
    b.set(3e6, true)
    const { keys, words } = b.pack()
    expect(keys).toHaveLength(2)
    const back = IdBits.unpack(keys, words)
    expect(back.size).toBe(2)
    expect(back.toArray()).toEqual([5, 3e6])
    expect(() => IdBits.unpack([0], new Uint32Array(5))).toThrow()
  })
})

describe('Selection', () => {
  it('matches a Set model through random edits, with and without Select All', () => {
    const r = rng(11)
    const table = Array.from({ length: 3000 }, (_, i) => i * 3 + 1)
    for (let run = 0; run < 10; run += 1) {
      let sel = Selection.none()
      const model = new Model(table)
      for (let step = 0; step < 200; step += 1) {
        const op = Math.floor(r() * 7)
        const a = Math.floor(r() * table.length)
        const b = Math.min(table.length - 1, a + Math.floor(r() * 300))
        const range = table.slice(a, b + 1)
        if (op === 0) {
          sel = Selection.everything(table.length)
          model.selected = new Set(table)
        } else if (op === 1) {
          sel = Selection.none()
          model.selected = new Set()
        } else if (op === 2) {
          sel = sel.toggle(table[a])
          if (model.selected.has(table[a])) model.selected.delete(table[a])
          else model.selected.add(table[a])
        } else if (op === 3) {
          // Strings, as the DOM grid keys rows.
          sel = sel.with(
            range.map((id) => String(id)),
            true,
          )
          range.forEach((id) => model.selected.add(id))
        } else if (op === 4) {
          sel = sel.with(new Uint32Array(range), false)
          range.forEach((id) => model.selected.delete(id))
        } else if (op === 5) {
          sel = Selection.of(range)
          model.selected = new Set(range)
        } else {
          sel = Selection.fromWire(sel.toWire())
        }
        const count = model.count()
        let wrong = sel.count === count && sel.isEmpty === (count === 0) ? 0 : 1
        for (let k = 0; k < 20; k += 1) {
          const id = table[Math.floor(r() * table.length)]
          const want = model.selected.has(id)
          if (sel.has(id) !== want || sel.has(String(id)) !== want) wrong += 1
        }
        expect(wrong).toBe(0)
      }
    }
  })

  it('is immutable: an edit leaves the old selection as it was', () => {
    const a = Selection.of([1, 2, 3])
    const b = a.toggle(2)
    const c = b.with([4], true)
    expect([a.has(2), b.has(2), c.has(4), b.has(4)]).toEqual([
      true,
      false,
      true,
      false,
    ])
    expect([a.count, b.count, c.count]).toEqual([3, 2, 3])
    // No change: the same object (React skips the re-render).
    expect(a.with([1, 2], true)).toBe(a)
    expect(a.with([99], false)).toBe(a)
  })

  it('Select All on 21M rows holds no ids and sends a few bytes', () => {
    const all = Selection.everything(21_000_000)
    expect(all.count).toBe(21_000_000)
    expect(all.isEverything).toBe(true)
    expect(all.has(20_999_999)).toBe(true)
    const wire = all.toWire()
    expect(wire.all).toBe(true)
    expect(wire.keys).toHaveLength(0)
    expect(wire.words.length).toBe(0)
    expect(all.explicitIds()).toBeNull()
    // Leaving rows out: only those are held.
    const out = all.with([5, 6, 7], false)
    expect(out.count).toBe(21_000_000 - 3)
    expect(out.isEverything).toBe(false)
    expect(out.has(6)).toBe(false)
    expect(out.toWire().words.length).toBe(2048) // one 8 KB page
    // Putting them back: everything again.
    expect(out.with([5, 6, 7], true).isEverything).toBe(true)
  })

  it('a range of 3M rows is bits (~1 bit per id), not an id list', () => {
    const range = new Uint32Array(3_000_000).map((_, i) => i + 1)
    const sel = Selection.of(range)
    expect(sel.count).toBe(3_000_000)
    const wire = sel.toWire()
    // 3M ids in 46 pages of 8 KB: under 400 KB on the wire (a string list: ~30 MB).
    expect(wire.words.byteLength).toBeLessThan(400_000)
    const back = Selection.fromWire(wire)
    expect(back.count).toBe(3_000_000)
    expect(back.has(3_000_000)).toBe(true)
    expect(back.has(3_000_001)).toBe(false)
  })

  it('names its ids only when they are a short list', () => {
    expect(Selection.of([9, 2, 5]).explicitIds()).toEqual([2, 5, 9])
    expect(Selection.of([9, 2, 5]).explicitIds(2)).toBeNull()
    expect(Selection.none().explicitIds()).toEqual([])
    expect(Selection.everything(10).explicitIds()).toBeNull()
  })

  it('follows the table size with Select All only', () => {
    const all = Selection.everything(100).with([1], false)
    const grown = all.withTotal(150)
    expect(grown.count).toBe(149)
    expect(grown.has(1)).toBe(false)
    expect(all.withTotal(100)).toBe(all)
    const some = Selection.of([1])
    expect(some.withTotal(150)).toBe(some)
  })

  it('reads a wire whose words arrive as another view of the bytes', () => {
    const wire = Selection.of([7, 70000]).toWire()
    const bytes = new Uint8Array(wire.words.buffer.slice(0))
    const back = Selection.fromWire({ ...wire, words: bytes as never })
    expect(back.count).toBe(2)
    expect(back.has(70000)).toBe(true)
  })

  it('refuses a wire it cannot read', () => {
    expect(() => Selection.fromWire(null)).toThrow()
    expect(() =>
      Selection.fromWire({
        all: false,
        total: 0,
        keys: [0],
        words: new Uint32Array(3),
      }),
    ).toThrow()
  })
})
