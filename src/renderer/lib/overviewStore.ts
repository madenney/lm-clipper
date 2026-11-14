/**
 * The tray overview's data in the renderer (docs/tray-v2.md): every row's id and
 * stage/tone/character bytes for one results table, pulled from main in chunks and kept
 * while you zoom around. Grows in place as chunks arrive (and as a running filter
 * adds rows), so the far-out view fills in progressively.
 */
import ipcBridge from '../ipcBridge'

export const OVERVIEW_BYTES = 3
/** The first byte: the stage in the low 6 bits (63 = none), the tone
 *  (lib/tileArt.ts TONE_*) in the top 2 (main/overview.ts stageToneByte). */
export const OVERVIEW_STAGE_NONE = 63
export const stageOfByte = (b: number) => b & OVERVIEW_STAGE_NONE
export const toneOfByte = (b: number) => b >> 6
/** Rows are stored in whole blocks of this many clips, so any GPU texture width
 *  that divides it (8192, 4096, 2048) uploads whole texture rows. */
export const ROW_BLOCK = 8192
const CHUNK = 250_000
/** A failed chunk is asked for again this many times (with a growing wait). */
const RETRIES = 3
const RETRY_MS = 500

type Cursor = { key: number; id: number; cached?: boolean } | null

export class OverviewData {
  ids = new Uint32Array(0)

  packed = new Uint8Array(0)

  count = 0

  done = false

  error: string | null = null

  /** Bumped whenever rows arrive (the canvas re-uploads what's new). */
  version = 0

  private cursor: Cursor = null

  private loading = false

  /** Dropped from the cache (overviewFor): stop reading. */
  private cancelled = false

  private listeners = new Set<() => void>()

  readonly filterId: string

  constructor(filterId: string) {
    this.filterId = filterId
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  private emit() {
    this.version += 1
    this.listeners.forEach((fn) => fn())
  }

  private ensure(capacity: number) {
    if (capacity <= this.ids.length) return
    // Whole blocks, so a GPU upload of whole texture rows never runs past the end.
    const want = Math.max(capacity, Math.ceil(this.ids.length * 1.5), 1024)
    const size = Math.ceil(want / ROW_BLOCK) * ROW_BLOCK
    const ids = new Uint32Array(size)
    ids.set(this.ids.subarray(0, this.count))
    const packed = new Uint8Array(size * OVERVIEW_BYTES)
    packed.set(this.packed.subarray(0, this.count * OVERVIEW_BYTES))
    this.ids = ids
    this.packed = packed
  }

  /** Read until caught up with `total` (or the table's end). Safe to call again. */
  load(total: number) {
    this.cancelled = false
    if (this.loading || (this.done && this.count >= total)) return
    if (this.done && this.count < total) this.done = false // a running filter grew
    this.loading = true
    this.error = null
    this.ensure(total)
    let failures = 0
    const step = () => {
      // The cursor this request continues from: a reply is only used while it
      // still is (main appends to the disk cache in the same order).
      const from = this.cursor
      ipcBridge.getOverviewChunk(
        { filterId: this.filterId, cursor: from, limit: CHUNK },
        (res) => {
          if (this.cancelled || from !== this.cursor) {
            this.loading = false
            return
          }
          if (!res || res.error || !res.ids || !res.packed) {
            failures += 1
            if (failures <= RETRIES) {
              setTimeout(step, RETRY_MS * 2 ** (failures - 1))
              return
            }
            this.error = res?.error ?? 'Could not read the overview.'
            this.loading = false
            this.emit()
            return
          }
          failures = 0
          const n = res.ids.length
          this.ensure(this.count + n)
          this.ids.set(res.ids, this.count)
          this.packed.set(res.packed, this.count * OVERVIEW_BYTES)
          this.count += n
          if (res.next) this.cursor = res.next
          this.done = !res.next
          this.emit()
          if (this.done) this.loading = false
          else step()
        },
      )
    }
    step()
  }

  /** Stop reading (a newer version of the table replaced this one). */
  cancel() {
    this.cancelled = true
  }
}

const cache = new Map<string, OverviewData>()

/** The overview for a table; `version` changes (reorder, re-run) start it fresh. */
export function overviewFor(filterId: string, version: string): OverviewData {
  const key = `${filterId}|${version}`
  let data = cache.get(key)
  if (!data) {
    for (const [k, old] of cache)
      if (k.startsWith(`${filterId}|`)) {
        old.cancel()
        cache.delete(k)
      }
    data = new OverviewData(filterId)
    cache.set(key, data)
    // Keep a few tables (each can be ~150 MB at 48M rows).
    while (cache.size > 3) {
      const [k, old] = cache.entries().next().value as [string, OverviewData]
      old.cancel()
      cache.delete(k)
    }
  }
  return data
}
