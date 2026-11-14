/**
 * Direct snapshot downloads, the parts the database, Clipper and the load-test tool
 * share (apps/database/docs/direct-downloads.md, docs/direct-load-test.md):
 *
 *   - coalesce(): which games are read together in one range request. R2 bytes are
 *     free and each request is a Class B operation, so this is the cost lever.
 *   - the prebuilt plan file (.ldp): every location of one selection (all Fox games,
 *     say) in a compact columnar form, built once after a snapshot rebuild and served
 *     from storage behind Cloudflare, so a big download's plan doesn't come over the
 *     home uplink page by page.
 *   - the manifest that says which filter each plan file answers exactly.
 *
 * Plain TypeScript with no imports beyond Node's Buffer and only erasable syntax, so
 * Node 24 runs it as it is (the load-test tool imports its copy directly).
 * Edit here, then `npm run sync-packages`.
 */

// ---------------------------------------------------------------------------
// Coalescing.

/** One located game: data at [offset, offset + length), its ZIP local header at `header`. */
export type LocatedEntry = {
  zip: number
  offset: number
  length: number
  header: number
}

export type Coalesce = {
  /** Largest stretch of bytes between two wanted entries to read through. */
  maxGap: number
  /** Largest range. */
  maxBytes: number
  /** Most games in one range. */
  maxGames: number
}

/**
 * Measured on 17 production selections (6.1M located games, read-only, 2026-10-19;
 * apps/database/docs/direct-load-test.md). The gap stays at 256 KiB: a game is
 * ~400 KB, so 512 KiB starts reading through whole unwanted games (Fox: 32% fewer
 * requests for 14% more bytes). Bigger ranges cost nothing extra and halve dense
 * selections: ranked 56 -> 28 requests per 1,000 games, a big tournament 68 -> 42;
 * every Fox game 429 -> 426 (its games are scattered among the others). 16 requests
 * in flight hold at most 256 MB.
 */
export const DEFAULT_COALESCE: Coalesce = {
  maxGap: 256 * 1024,
  maxBytes: 16 * 1024 * 1024,
  maxGames: 256,
}

/** The settings before 2026-10-19 (kept for comparisons). */
export const LEGACY_COALESCE: Coalesce = {
  maxGap: 256 * 1024,
  maxBytes: 8 * 1024 * 1024,
  maxGames: 64,
}

/**
 * The streamed bundles' settings (the bundle Worker, deploy/cloudflare/bundle-worker, and the database's part
 * cutting, services/streamParts.ts, which must count reads exactly as the Worker makes them). R2 reads are the
 * Worker's scarcest resource (a request may make a limited number) and bytes cost nothing, so it reads through up
 * to 1 MiB of unwanted bytes between two replays. One definition, so the two can't drift apart.
 */
export const STREAM_COALESCE: Coalesce = {
  maxGap: 1024 * 1024,
  maxBytes: 16 * 1024 * 1024,
  maxGames: 256,
}

export type Range = { zip: number; start: number; end: number; items: number[] }

/**
 * Ranges over `order` (entry indexes sorted by zip, offset), skipping `skip`.
 * `start`/`end` are byte positions, end exclusive; a range runs from the first
 * entry's local header to the last entry's data end.
 */
export function* coalesce(
  entries: ArrayLike<LocatedEntry>,
  order: ArrayLike<number>,
  skip: (_i: number) => boolean,
  opts: Coalesce = DEFAULT_COALESCE,
): Generator<Range> {
  let cur: Range | null = null
  for (let k = 0; k < order.length; k++) {
    const i = order[k]
    if (skip(i)) continue
    const e = entries[i]
    const end = e.offset + e.length
    if (
      cur &&
      cur.zip === e.zip &&
      e.header >= cur.end &&
      e.header - cur.end <= opts.maxGap &&
      end - cur.start <= opts.maxBytes &&
      cur.items.length < opts.maxGames
    ) {
      cur.end = end
      cur.items.push(i)
      continue
    }
    if (cur) yield cur
    cur = { zip: e.zip, start: e.header, end, items: [i] }
  }
  if (cur) yield cur
}

// ---------------------------------------------------------------------------
// The prebuilt plan file.

/** One zip as the database describes it. `id` is `<key>@<etag>`. */
export type PlanSnapshot = {
  id: string
  key: string
  etag: string
  size: number
  kind: 'full' | 'delta'
}

export type PlanRow = LocatedEntry & {
  /** 24 hex. */
  id: string
  /** The database's content hash (32 hex), or '' when it has none in that form. */
  hash: string
}

export type PlanFileMeta = {
  v: 1
  /** Zips the rows point into (a row's `zip` indexes this). */
  snapshots: PlanSnapshot[]
  /** The selection (a replay filter as Clipper sends it, without maxFiles/sort). */
  filter: Record<string, string | boolean>
  /** Rows, ids in no zip (newer games, when the plan lists them), stored bytes. */
  count: number
  other: number
  bytes: number
  builtAt: string
}

export type PlanFile = { meta: PlanFileMeta; games: PlanRow[]; other: string[] }

const MAGIC = 'LDP1'
const ID_RE = /^[0-9a-f]{24}$/
const HASH_RE = /^[0-9a-f]{32}$/

class Writer {
  private buf = Buffer.alloc(1 << 16)

  len = 0

  private room(n: number) {
    if (this.len + n <= this.buf.length) return
    let size = this.buf.length * 2
    while (size < this.len + n) size *= 2
    const next = Buffer.alloc(size)
    this.buf.copy(next, 0, 0, this.len)
    this.buf = next
  }

  bytes(b: Buffer) {
    this.room(b.length)
    b.copy(this.buf, this.len)
    this.len += b.length
  }

  u32(n: number) {
    this.room(4)
    this.buf.writeUInt32LE(n, this.len)
    this.len += 4
  }

  /** Unsigned LEB128 for any safe integer (no 32-bit bit operations). */
  varint(n: number) {
    if (!Number.isSafeInteger(n) || n < 0) throw new Error(`Not a plan number: ${n}`)
    this.room(8)
    let v = n
    while (v >= 128) {
      this.buf[this.len++] = (v % 128) + 128
      v = Math.floor(v / 128)
    }
    this.buf[this.len++] = v
  }

  done(): Buffer {
    return this.buf.subarray(0, this.len)
  }
}

class Reader {
  at = 0

  private readonly buf: Buffer

  constructor(buf: Buffer) {
    this.buf = buf
  }

  need(n: number) {
    if (this.at + n > this.buf.length) throw new Error('The plan file is cut short.')
  }

  bytes(n: number): Buffer {
    this.need(n)
    const out = this.buf.subarray(this.at, this.at + n)
    this.at += n
    return out
  }

  u32(): number {
    this.need(4)
    const v = this.buf.readUInt32LE(this.at)
    this.at += 4
    return v
  }

  varint(): number {
    let v = 0
    let mul = 1
    for (let k = 0; k < 8; k++) {
      this.need(1)
      const b = this.buf[this.at++]
      v += (b & 127) * mul
      if (b < 128) return v
      mul *= 128
    }
    throw new Error('The plan file has a bad number.')
  }
}

const zigzag = (n: number) => (n >= 0 ? n * 2 : -n * 2 - 1)
const unzigzag = (n: number) => (n % 2 === 0 ? n / 2 : -(n + 1) / 2)

/**
 * The plan file: "LDP1", meta JSON, then columns over the games in (zip, offset)
 * order: zip runs, ids (12 bytes), a hash bitmap and hashes (16 bytes), and three
 * varint columns (header - previous end, offset - header, length); then the other
 * ids. Columns compress well (gaps are 0 when games sit side by side): ~32 bytes a
 * game raw, ~25 after brotli, against ~140 as JSON pages (~60 gzipped).
 */
export function encodePlanFile(
  meta: Omit<PlanFileMeta, 'v' | 'count' | 'other' | 'bytes'>,
  games: PlanRow[],
  other: string[] = [],
): Buffer {
  const rows = [...games].sort((a, b) => a.zip - b.zip || a.offset - b.offset)
  let bytes = 0
  for (const r of rows) {
    if (!ID_RE.test(r.id)) throw new Error(`Bad replay id ${r.id}`)
    if (!(r.zip >= 0 && r.zip < meta.snapshots.length)) throw new Error('Row points at no zip.')
    if (!(r.header >= 0 && r.header < r.offset && r.length > 0)) throw new Error('Bad location.')
    bytes += r.length
  }
  const full: PlanFileMeta = { v: 1, ...meta, count: rows.length, other: other.length, bytes }
  const w = new Writer()
  w.bytes(Buffer.from(MAGIC, 'latin1'))
  const json = Buffer.from(JSON.stringify(full), 'utf8')
  w.u32(json.length)
  w.bytes(json)
  // Zip runs.
  const runs: [number, number][] = []
  for (const r of rows) {
    const last = runs[runs.length - 1]
    if (last && last[0] === r.zip) last[1]++
    else runs.push([r.zip, 1])
  }
  w.varint(runs.length)
  for (const [z, n] of runs) {
    w.varint(z)
    w.varint(n)
  }
  for (const r of rows) w.bytes(Buffer.from(r.id, 'hex'))
  const bitmap = Buffer.alloc(Math.ceil(rows.length / 8))
  rows.forEach((r, i) => {
    if (HASH_RE.test(r.hash)) bitmap[i >> 3] |= 1 << (i & 7)
  })
  w.bytes(bitmap)
  for (const r of rows) if (HASH_RE.test(r.hash)) w.bytes(Buffer.from(r.hash, 'hex'))
  let prevEnd = 0
  let prevZip = -1
  for (const r of rows) {
    if (r.zip !== prevZip) {
      prevEnd = 0
      prevZip = r.zip
    }
    w.varint(zigzag(r.header - prevEnd))
    prevEnd = r.offset + r.length
  }
  for (const r of rows) w.varint(r.offset - r.header)
  for (const r of rows) w.varint(r.length)
  for (const id of other) {
    if (!ID_RE.test(id)) throw new Error(`Bad replay id ${id}`)
    w.bytes(Buffer.from(id, 'hex'))
  }
  return w.done()
}

/** A plan file's games as columns (no object per game: every Fox game is ~1.4M). */
export type PlanColumns = {
  meta: PlanFileMeta
  /** 12 bytes per game. */
  ids: Buffer
  /** Bit i set: game i has a hash, the next 16 bytes of `hashes`. */
  hashBitmap: Buffer
  hashes: Buffer
  zips: Uint16Array
  headers: Float64Array
  offsets: Float64Array
  lengths: Float64Array
  /** 12 bytes per id in no zip. */
  other: Buffer
}

export function decodePlanColumns(buf: Buffer): PlanColumns {
  const r = new Reader(buf)
  if (r.bytes(4).toString('latin1') !== MAGIC) throw new Error('Not a plan file.')
  const meta = JSON.parse(r.bytes(r.u32()).toString('utf8')) as PlanFileMeta
  if (meta?.v !== 1 || !Array.isArray(meta.snapshots) || !Number.isSafeInteger(meta.count) || !Number.isSafeInteger(meta.other))
    throw new Error('Unknown plan file version.')
  const n = meta.count
  // Every game and every other id takes 12 bytes of the file: a count the file cannot hold is
  // damage or hostile input, refused before any array is sized from it.
  if (n < 0 || meta.other < 0 || n + meta.other > buf.length / 12) throw new Error('The plan file is damaged.')
  const zips = new Uint16Array(n)
  let at = 0
  const runCount = r.varint()
  for (let k = 0; k < runCount; k++) {
    const z = r.varint()
    const len = r.varint()
    if (z >= meta.snapshots.length || at + len > n) throw new Error('The plan file is damaged.')
    zips.fill(z, at, at + len)
    at += len
  }
  if (at !== n) throw new Error('The plan file is damaged.')
  const ids = r.bytes(n * 12)
  const hashBitmap = r.bytes(Math.ceil(n / 8))
  let hashed = 0
  for (let i = 0; i < n; i++) hashed += (hashBitmap[i >> 3] >> (i & 7)) & 1
  const hashes = r.bytes(hashed * 16)
  const headers = new Float64Array(n)
  const offsets = new Float64Array(n)
  const lengths = new Float64Array(n)
  for (let i = 0; i < n; i++) headers[i] = unzigzag(r.varint())
  for (let i = 0; i < n; i++) offsets[i] = r.varint()
  let prevEnd = 0
  let prevZip = -1
  let bytes = 0
  for (let i = 0; i < n; i++) {
    if (zips[i] !== prevZip) {
      prevEnd = 0
      prevZip = zips[i]
    }
    const length = r.varint()
    headers[i] += prevEnd
    offsets[i] += headers[i]
    lengths[i] = length
    if (!(length > 0 && headers[i] >= 0)) throw new Error('The plan file is damaged.')
    prevEnd = offsets[i] + length
    bytes += length
  }
  const other = r.bytes(meta.other * 12)
  if (r.at !== buf.length) throw new Error('The plan file has trailing bytes.')
  if (bytes !== meta.bytes) throw new Error('The plan file is damaged.')
  return { meta, ids, hashBitmap, hashes, zips, headers, offsets, lengths, other }
}

export function decodePlanFile(buf: Buffer): PlanFile {
  const c = decodePlanColumns(buf)
  const n = c.meta.count
  const games: PlanRow[] = new Array(n)
  let h = 0
  for (let i = 0; i < n; i++) {
    const hashed = (c.hashBitmap[i >> 3] >> (i & 7)) & 1
    games[i] = {
      id: c.ids.toString('hex', i * 12, i * 12 + 12),
      hash: hashed ? c.hashes.toString('hex', h * 16, ++h * 16) : '',
      zip: c.zips[i],
      offset: c.offsets[i],
      length: c.lengths[i],
      header: c.headers[i],
    }
  }
  const other: string[] = new Array(c.meta.other)
  for (let i = 0; i < c.meta.other; i++) other[i] = c.other.toString('hex', i * 12, i * 12 + 12)
  return { meta: c.meta, games, other }
}

// ---------------------------------------------------------------------------
// The manifest: which filter each prebuilt plan answers.

export type PlanManifestEntry = {
  /** The selection, as Clipper's export filter without maxFiles/sort. */
  filter: Record<string, string | boolean>
  /** Path next to the manifest. */
  file: string
  /** SHA-256 (hex) of the file as served (compressed). */
  sha256: string
  /** Size as served. */
  size: number
  /** 'br' (brotli) or 'none'. */
  encoding: 'br' | 'none'
  /** Games in the plan (all in `snapshot`), and how many the selection had when it was built. */
  games: number
  selected: number
  bytes: number
}

export type PlanManifest = {
  v: 1
  /** The zip every prebuilt plan points into (the full DB): `<key>@<etag>`. */
  snapshot: string
  builtAt: string
  plans: PlanManifestEntry[]
}

/** Filter fields that only order or cut a selection, not choose it. */
// storedOnly (Clipper always sends it) doesn't change what a prebuilt plan answers: its
// games all sit in the full-DB zip, and the rest come from the locations pages.
const NOT_SELECTION = new Set(['maxFiles', 'sort', 'cursor', 'limit', 'count', 'exceptSnapshot', 'storedOnly'])

/**
 * The selection part of a filter as a stable string: fields sorted, values as
 * strings (true for flags), list values sorted, empty ones dropped.
 */
export function selectionKey(filter: Record<string, unknown>): string {
  const out: Record<string, string | boolean> = {}
  for (const k of Object.keys(filter).sort()) {
    if (NOT_SELECTION.has(k)) continue
    const v = filter[k]
    if (v === undefined || v === null || v === '' || v === false) continue
    if (v === true) out[k] = true
    else if (typeof v === 'string' || typeof v === 'number') {
      const parts = String(v).split(',').map((s) => s.trim()).filter(Boolean).sort()
      if (parts.length) out[k] = parts.join(',')
    } else return '' // a list of ids, a clip search: never prebuilt
  }
  return JSON.stringify(out)
}

/**
 * The prebuilt plan that answers this filter exactly, if any: the same selection,
 * asking for all of it (maxFiles at least what the selection had when the plan was
 * built, so the date order doesn't matter), and pointing into the zip the caller
 * says is current.
 */
export function findPrebuiltPlan(
  manifest: PlanManifest,
  filter: Record<string, unknown>,
  currentSnapshot?: string,
): PlanManifestEntry | null {
  if (manifest?.v !== 1 || !Array.isArray(manifest.plans)) return null
  if (currentSnapshot && manifest.snapshot !== currentSnapshot) return null
  if (Array.isArray(filter.replayIds) || filter.clipSearch != null) return null
  const key = selectionKey(filter)
  if (!key || key === '{}') return null
  const maxFiles = Number(filter.maxFiles)
  for (const p of manifest.plans) {
    if (selectionKey(p.filter) !== key) continue
    if (filter.maxFiles != null && !(maxFiles >= p.selected)) return null
    return p
  }
  return null
}
