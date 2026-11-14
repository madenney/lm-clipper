/**
 * The far-out view's selection as one byte per clip in index space
 * (docs/tray-v2.md), kept up to date incrementally so it never costs O(rows) per
 * overview chunk or per click:
 *  - a chunk of new rows marks only those rows (`extend`);
 *  - a click, Ctrl-click or drag in the overview says which rows it touched
 *    (`MaskHint`), so only those rows are re-marked;
 *  - any other change clears just the band that held marks, then marks again;
 *  - the GPU uploads only the texture rows that changed (`takeDirtyRows`).
 * Marks follow the selection's bits (lib/selection.ts): the selected rows, or
 * with Select All the rows left out, and the shader inverts them (`invert`), so
 * "everything selected" is a flag, not 21M marks.
 */
import type { IdBits, Selection } from '../../lib/selection'

/**
 * What a selection change touched: rows [lo, hi] are re-marked from the new
 * selection; every other row keeps its mark (`keep`) or is cleared.
 */
export type MaskHint = { lo: number; hi: number; keep: boolean }

export class SelectionMask {
  mask = new Uint8Array(0)

  /** Bumped on every change (the CPU renderer redraws on it). */
  version = 0

  /** The overview data this mask belongs to (a new one starts it fresh). */
  private source: unknown = null

  /** Rows [0, scanned) are marked for the current selection. */
  private scanned = 0

  /** The ids to mark (the selection's bits); null when none. */
  private wanted: IdBits | null = null

  /** Marks are the rows left out (Select All): the shader inverts them. */
  invert = false

  /** Every marked row lies in [markLo, markHi). */
  private markLo = Infinity

  private markHi = 0

  /** Rows changed since the last `takeDirtyRows`: [dirtyLo, dirtyHi). */
  private dirtyLo = Infinity

  private dirtyHi = 0

  /** Follow `source` (a new one starts fresh, keeping the selection) and its capacity. */
  attach(source: unknown, capacity: number) {
    if (source !== this.source) {
      this.source = source
      this.mask = new Uint8Array(capacity)
      this.scanned = 0
      this.markLo = Infinity
      this.markHi = 0
      this.dirty(0, capacity)
      this.version += 1
    } else if (this.mask.length < capacity) {
      const grown = new Uint8Array(capacity)
      grown.set(this.mask)
      this.mask = grown
      this.version += 1
    }
  }

  /**
   * A new selection. With a hint (only valid when the mask was in step with the
   * selection before it) just rows [lo, hi] are looked at; otherwise the band
   * that held marks is cleared and every loaded row is marked again.
   */
  select(
    ids: Uint32Array,
    count: number,
    selection: Selection,
    hint?: MaskHint | null,
  ) {
    const wasInvert = this.invert
    this.invert = selection.all
    const wanted = selection.bits.size ? selection.bits : null
    this.wanted = wanted
    const n = Math.min(count, ids.length, this.mask.length)
    if (hint && wasInvert === this.invert && this.scanned >= n) {
      if (!hint.keep) this.clearMarks()
      const hi = Math.min(hint.hi, n - 1)
      for (let i = Math.max(0, hint.lo); i <= hi; i += 1)
        this.set(i, wanted !== null && wanted.has(ids[i]))
    } else {
      this.clearMarks()
      this.scanned = 0
      this.extend(ids, count)
    }
    this.version += 1
  }

  /** Mark rows that arrived since the last call; returns whether any changed. */
  extend(ids: Uint32Array, count: number) {
    const n = Math.min(count, ids.length, this.mask.length)
    if (n <= this.scanned) return false
    const from = this.scanned
    this.scanned = n
    const { wanted } = this
    if (!wanted) return false
    let changed = false
    for (let i = from; i < n; i += 1)
      if (wanted.has(ids[i])) {
        this.set(i, true)
        changed = true
      }
    if (changed) this.version += 1
    return changed
  }

  /**
   * The texture rows to upload, [y0, y1) for a texture `texW` wide and `rows`
   * tall (null: nothing changed), and forget them.
   */
  takeDirtyRows(texW: number, rows: number): [number, number] | null {
    if (this.dirtyLo >= this.dirtyHi) return null
    const y0 = Math.floor(this.dirtyLo / texW)
    const y1 = Math.min(rows, Math.ceil(this.dirtyHi / texW))
    this.dirtyLo = Infinity
    this.dirtyHi = 0
    return y0 < y1 ? [y0, y1] : null
  }

  private set(i: number, on: boolean) {
    const v = on ? 1 : 0
    if (this.mask[i] === v) return
    this.mask[i] = v
    this.dirty(i, i + 1)
    if (on) {
      if (i < this.markLo) this.markLo = i
      if (i + 1 > this.markHi) this.markHi = i + 1
    }
  }

  private clearMarks() {
    if (this.markLo >= this.markHi) return
    this.mask.fill(0, this.markLo, this.markHi)
    this.dirty(this.markLo, this.markHi)
    this.markLo = Infinity
    this.markHi = 0
  }

  private dirty(lo: number, hi: number) {
    if (lo < this.dirtyLo) this.dirtyLo = lo
    if (hi > this.dirtyHi) this.dirtyHi = hi
  }
}
