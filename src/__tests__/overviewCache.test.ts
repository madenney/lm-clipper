/**
 * @jest-environment node
 *
 * The overview's disk cache (main/overviewCache.ts): a cache is only saved when
 * one read wrote every row once, in order, and only served when it holds the
 * table's row count. A chunk asked for twice (the renderer gave up waiting) or a
 * stale read appending to a newer one used to leave duplicated rows, shifting
 * every position after them. The real SQLite reads are in
 * scripts/worker-check/overview.js.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  CACHE_MIN_ROWS,
  OVERVIEW_CACHE_VERSION,
  OverviewCacheWriter,
  cachedCount,
  cachedOverview,
  readCachedChunk,
  setOverviewCacheDir,
} from '../main/overviewCache'

jest.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }))

const N = CACHE_MIN_ROWS
let dir = ''
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-cache-'))
  setOverviewCacheDir(dir)
})
afterEach(() => {
  setOverviewCacheDir(null)
  fs.rmSync(dir, { recursive: true, force: true })
})

const rows = (from: number, n: number) => ({
  ids: new Uint32Array(n).map((_, i) => from + i + 1),
  packed: new Uint8Array(n * 3).fill(7),
})
const at = (id: number) => ({ key: id, id })

/** Write `n` rows in chunks the way the controller does. */
async function fullRead(w: OverviewCacheWriter, n: number, chunk = 200_000) {
  let cursor: { key: number; id: number } | null = null
  for (let from = 0; from < n; from += chunk) {
    const k = Math.min(chunk, n - from)
    const next = from + k < n ? at(from + k) : null
    expect(w.follows(cursor)).toBe(true)
    const r = rows(from, k)
    w.append(r.ids, r.packed, next)
    cursor = next
  }
  await w.finish()
}

describe('overview disk cache', () => {
  it('saves a whole read and serves it for the same fingerprint and count', async () => {
    await fullRead(new OverviewCacheWriter('/p.lunar', 'f', 'sig:N', N), N)
    const meta = await cachedOverview('/p.lunar', 'f', 'sig:N', N)
    expect(meta?.count).toBe(N)
    const back = await readCachedChunk('/p.lunar', 'f', N - 3, 10, N)
    expect(Array.from(back.ids)).toEqual([N - 2, N - 1, N])
  })

  it('serves nothing for another row count', async () => {
    await fullRead(new OverviewCacheWriter('/p.lunar', 'f', 'sig', N), N)
    expect(await cachedOverview('/p.lunar', 'f', 'sig', N + 5)).toBeNull()
  })

  it('a chunk that does not follow on is refused (asked for again)', () => {
    const w = new OverviewCacheWriter('/p.lunar', 'f', 'sig', N)
    const r = rows(0, 250_000)
    w.append(r.ids, r.packed, at(250_000))
    // The renderer gave up on the next chunk and asks again from the same place:
    // that follows on. Asking again for the first chunk does not.
    expect(w.follows(at(250_000))).toBe(true)
    expect(w.follows(null)).toBe(false)
    expect(w.follows(at(100))).toBe(false)
  })

  it('never saves more or fewer rows than the table has', async () => {
    const extra = new OverviewCacheWriter('/p.lunar', 'x', 'sig', N)
    const r = rows(0, N)
    extra.append(r.ids, r.packed, at(N))
    const again = rows(N - 10, 10)
    extra.append(again.ids, again.packed, null) // rows in twice
    await extra.finish()
    expect(await cachedOverview('/p.lunar', 'x', 'sig', N)).toBeNull()
    expect(await cachedOverview('/p.lunar', 'x', 'sig', N + 10)).toBeNull()

    const short = new OverviewCacheWriter('/p.lunar', 'y', 'sig', N + 1)
    await fullRead(short, N)
    expect(await cachedOverview('/p.lunar', 'y', 'sig', N + 1)).toBeNull()
    // No temporary files left behind.
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('two reads of one table write separate files (a stale one cannot spoil the other)', async () => {
    const stale = new OverviewCacheWriter('/p.lunar', 'f', 'old', N)
    const fresh = new OverviewCacheWriter('/p.lunar', 'f', 'new', N)
    const s = rows(1_000_000, 300_000)
    stale.append(s.ids, s.packed, at(1_300_000))
    await fullRead(fresh, N)
    await stale.discard()
    const meta = await cachedOverview('/p.lunar', 'f', 'new', N)
    expect(meta?.count).toBe(N)
    const back = await readCachedChunk('/p.lunar', 'f', 0, 2, N)
    expect(Array.from(back.ids)).toEqual([1, 2])
  })

  it('rebuilds a cache written before the tone bits (version 1), never reads it', async () => {
    expect(OVERVIEW_CACHE_VERSION).toBeGreaterThanOrEqual(2)
    await fullRead(new OverviewCacheWriter('/p.lunar', 'f', 'sig', N), N)
    expect(await cachedOverview('/p.lunar', 'f', 'sig', N)).not.toBeNull()
    // The same files, as an older Clipper left them.
    const meta = fs.readdirSync(dir).find((f) => f.endsWith('.json'))!
    const file = path.join(dir, meta)
    const old = JSON.parse(fs.readFileSync(file, 'utf8'))
    fs.writeFileSync(file, JSON.stringify({ ...old, version: 1 }))
    expect(await cachedOverview('/p.lunar', 'f', 'sig', N)).toBeNull()
    expect(await cachedCount('/p.lunar', 'f')).toBeNull()
  })

  it('keeps the tone bits byte for byte', async () => {
    const w = new OverviewCacheWriter('/p.lunar', 't', 'sig', N)
    const r = rows(0, N)
    // stage 8 + kill, 31 + hot, no stage + kill
    r.packed.set([
      8 | (1 << 6),
      2,
      9,
      31 | (2 << 6),
      20,
      1,
      63 | (1 << 6),
      255,
      255,
    ])
    w.append(r.ids, r.packed, null)
    await w.finish()
    const back = await readCachedChunk('/p.lunar', 't', 0, 3, N)
    expect(Array.from(back.packed)).toEqual([
      72, 2, 9, 159, 20, 1, 127, 255, 255,
    ])
  })
})
