/**
 * The tray's selection (docs/tray-v2.md), sized for tables of tens of millions of
 * rows: either "these rows" or "every row except these", with the rows held as
 * bits by row id. Select All is a flag (O(1), whatever the table's size); a range
 * of millions of rows is a few MB of bits, not millions of id strings; nothing
 * ever lists every id of a table. Main turns a selection into rows only when an
 * action needs them (main/selectionSql.ts), from the compact form `toWire` sends.
 *
 * Shared by the renderer and main (no DOM, no Node).
 */

/** Row ids per page of bits (8 KB each). */
const PAGE_IDS = 65536
const PAGE_WORDS = PAGE_IDS / 32

/** One bit per row id, in pages that exist only where a bit was ever set. */
export class IdBits {
  /** Bits set (the number of ids held). */
  size = 0

  private pages: Map<number, Uint32Array>

  /** Pages this instance may write; shared pages are copied first. */
  private owned = new Set<Uint32Array>()

  constructor(pages?: Map<number, Uint32Array>, size = 0) {
    this.pages = pages ?? new Map()
    this.size = size
  }

  /** A copy sharing every page until one is written (copy-on-write). */
  copy(): IdBits {
    return new IdBits(new Map(this.pages), this.size)
  }

  has(id: number): boolean {
    if (!(id >= 0) || !Number.isInteger(id)) return false
    const page = this.pages.get(Math.floor(id / PAGE_IDS))
    if (!page) return false
    const bit = id % PAGE_IDS
    return (page[bit >>> 5] & (1 << (bit & 31))) !== 0
  }

  /** Set or clear one id; returns whether it changed. */
  set(id: number, on: boolean): boolean {
    if (!(id >= 0) || !Number.isInteger(id)) return false
    const key = Math.floor(id / PAGE_IDS)
    let page = this.pages.get(key)
    if (!page) {
      if (!on) return false
      page = new Uint32Array(PAGE_WORDS)
      this.pages.set(key, page)
      this.owned.add(page)
    }
    const bit = id % PAGE_IDS
    const w = bit >>> 5
    const m = 1 << (bit & 31)
    if (((page[w] & m) !== 0) === on) return false
    if (!this.owned.has(page)) {
      page = page.slice()
      this.pages.set(key, page)
      this.owned.add(page)
    }
    page[w] ^= m
    this.size += on ? 1 : -1
    return true
  }

  /** Every id, ascending, as [lo, hi] runs of consecutive ids. */
  forEachRun(fn: (_lo: number, _hi: number) => void) {
    const keys = [...this.pages.keys()].sort((a, b) => a - b)
    let lo = -1
    let hi = -2
    for (const key of keys) {
      const page = this.pages.get(key)!
      const base = key * PAGE_IDS
      for (let w = 0; w < PAGE_WORDS; w += 1) {
        const word = page[w]
        if (word === 0) continue
        const wbase = base + w * 32
        if (word === 0xffffffff) {
          // A full word: 32 ids in one step.
          if (wbase === hi + 1) hi = wbase + 31
          else {
            if (lo >= 0) fn(lo, hi)
            lo = wbase
            hi = wbase + 31
          }
          continue
        }
        for (let b = 0; b < 32; b += 1) {
          if ((word & (1 << b)) === 0) continue
          const id = wbase + b
          if (id === hi + 1) hi = id
          else {
            if (lo >= 0) fn(lo, hi)
            lo = id
            hi = id
          }
        }
      }
    }
    if (lo >= 0) fn(lo, hi)
  }

  /** Up to `limit` ids, ascending. */
  toArray(limit = Infinity): number[] {
    const out: number[] = []
    const max = Math.min(limit, this.size)
    if (max <= 0) return out
    try {
      this.forEachRun((lo, hi) => {
        for (let id = lo; id <= hi; id += 1) {
          if (out.length >= max) throw out
          out.push(id)
        }
      })
    } catch (e) {
      if (e !== out) throw e
    }
    return out
  }

  /** The non-empty pages: their keys, and their words one after another. */
  pack(): { keys: number[]; words: Uint32Array } {
    const keys = [...this.pages.keys()]
      .sort((a, b) => a - b)
      .filter((k) => this.pages.get(k)!.some((w) => w !== 0))
    const words = new Uint32Array(keys.length * PAGE_WORDS)
    keys.forEach((k, i) => words.set(this.pages.get(k)!, i * PAGE_WORDS))
    return { keys, words }
  }

  static unpack(keys: ArrayLike<number>, words: Uint32Array): IdBits {
    if (words.length !== keys.length * PAGE_WORDS)
      throw new Error('Selection: pages and words disagree.')
    const pages = new Map<number, Uint32Array>()
    let size = 0
    for (let i = 0; i < keys.length; i += 1) {
      const key = keys[i]
      if (!Number.isInteger(key) || key < 0)
        throw new Error('Selection: bad page.')
      const page = words.slice(i * PAGE_WORDS, (i + 1) * PAGE_WORDS)
      for (let w = 0; w < PAGE_WORDS; w += 1) {
        let v = page[w]
        // Bits set in the word (popcount).
        v -= (v >>> 1) & 0x55555555
        v = (v & 0x33333333) + ((v >>> 2) & 0x33333333)
        size += (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24
      }
      pages.set(key, page)
    }
    return new IdBits(pages, size)
  }
}

/** A selection as it crosses IPC: a flag, a count and bits, never an id list. */
export type SelectionWire = {
  all: boolean
  /** The table's row count when `all` (what "every row" meant to the tray). */
  total: number
  keys: number[]
  words: Uint32Array
}

const toId = (id: number | string) => (typeof id === 'number' ? id : Number(id))

/**
 * Immutable: every change returns a new Selection (React state), sharing the
 * untouched pages of bits with the old one.
 */
export class Selection {
  /** Every row except `bits` (true), or just `bits` (false). */
  readonly all: boolean

  /** The rows named: selected ones, or with `all` the ones left out. */
  readonly bits: IdBits

  /** With `all`: the table's row count, for `count`. */
  readonly total: number

  private constructor(all: boolean, bits: IdBits, total: number) {
    this.all = all
    this.bits = bits
    this.total = total
  }

  static none(): Selection {
    return new Selection(false, new IdBits(), 0)
  }

  /** Every row of a table of `total` rows (Select All): no ids at all. */
  static everything(total: number): Selection {
    return new Selection(true, new IdBits(), Math.max(0, total))
  }

  /** Just these rows. */
  static of(ids: Iterable<number | string> | ArrayLike<number>): Selection {
    return Selection.none().with(ids, true)
  }

  static fromWire(w: SelectionWire | null | undefined): Selection {
    const raw: unknown = w?.words
    // Typed arrays survive IPC as themselves; take any view of the same bytes.
    const words =
      raw instanceof Uint32Array
        ? raw
        : ArrayBuffer.isView(raw) && raw.byteLength % 4 === 0
          ? new Uint32Array(
              raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
            )
          : null
    if (!w || typeof w !== 'object' || !words)
      throw new Error('Selection: unreadable.')
    const keys = Array.isArray(w.keys) ? w.keys : []
    return new Selection(
      !!w.all,
      IdBits.unpack(keys, words),
      Math.max(0, Number(w.total) || 0),
    )
  }

  /** How many rows are selected. */
  get count(): number {
    return this.all ? Math.max(0, this.total - this.bits.size) : this.bits.size
  }

  get isEmpty(): boolean {
    return this.count === 0
  }

  /** Select All with nothing left out. */
  get isEverything(): boolean {
    return this.all && this.bits.size === 0 && this.total > 0
  }

  has(id: number | string): boolean {
    return this.bits.has(toId(id)) !== this.all
  }

  /** Select (`on`) or deselect these rows. Unchanged: the same Selection. */
  with(
    ids: Iterable<number | string> | ArrayLike<number>,
    on: boolean,
  ): Selection {
    const bits = this.bits.copy()
    // With `all`, the bits are the rows left out: selecting clears them.
    const bit = on !== this.all
    let changed = false
    if (ids instanceof Uint32Array || Array.isArray(ids)) {
      for (let i = 0; i < ids.length; i += 1)
        if (bits.set(toId(ids[i]), bit)) changed = true
    } else if (Symbol.iterator in Object(ids)) {
      for (const id of ids as Iterable<number | string>)
        if (bits.set(toId(id), bit)) changed = true
    } else {
      const list = ids as ArrayLike<number>
      for (let i = 0; i < list.length; i += 1)
        if (bits.set(toId(list[i]), bit)) changed = true
    }
    return changed ? new Selection(this.all, bits, this.total) : this
  }

  toggle(id: number | string): Selection {
    return this.with([toId(id)], !this.has(id))
  }

  /** Follow the table's row count (a running filter grows). */
  withTotal(total: number): Selection {
    if (!this.all || total === this.total) return this
    return new Selection(true, this.bits, Math.max(0, total))
  }

  /**
   * The selected ids, ascending, when they're a plain list of at most `limit`;
   * null for Select All or a bigger selection (main resolves those).
   */
  explicitIds(limit = Infinity): number[] | null {
    if (this.all || this.bits.size > limit) return null
    return this.bits.toArray()
  }

  toWire(): SelectionWire {
    const { keys, words } = this.bits.pack()
    return { all: this.all, total: this.total, keys, words }
  }
}
