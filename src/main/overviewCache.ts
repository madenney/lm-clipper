import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import { OVERVIEW_BYTES } from './overview'

/**
 * The tray overview on disk (docs/tray-v2.md): reading a 48M-row table's overview
 * from SQLite takes over a minute, so once it has been read in full it's kept in
 * the app's data folder (not the project folder) and the next zoom-out streams it
 * from there. Keyed by project + filter; valid while the table's fingerprint
 * (overview.ts readOverviewSignature) is unchanged; a reorder deletes it.
 *
 * Only tables of CACHE_MIN_ROWS or more are cached; the folder is kept under
 * CACHE_MAX_BYTES by dropping the least recently used.
 */
export const CACHE_MIN_ROWS = 500_000
const CACHE_MAX_BYTES = 2 * 1024 ** 3
/**
 * The file format. 2 (2026-10-16): the first byte carries the tone in its top
 * two bits (overview.ts stageToneByte); a version-1 file's stage bytes would
 * read as tones, so it's rebuilt, not read.
 */
export const OVERVIEW_CACHE_VERSION = 2
const VERSION = OVERVIEW_CACHE_VERSION

type Meta = { version: number; signature: string; count: number }

let dirOverride: string | null = null
/** Tests: put the cache somewhere else. */
export function setOverviewCacheDir(dir: string | null) {
  dirOverride = dir
}
const cacheDir = () =>
  dirOverride ?? path.join(app.getPath('userData'), 'overview-cache')

function base(projectPath: string, filterId: string) {
  const project = crypto
    .createHash('sha1')
    .update(projectPath)
    .digest('hex')
    .slice(0, 16)
  return path.join(cacheDir(), `${project}-${filterId.replace(/[^\w-]/g, '_')}`)
}

/** The cache for this fingerprint, holding exactly `count` rows (else null). */
export async function cachedOverview(
  projectPath: string,
  filterId: string,
  signature: string,
  count: number,
): Promise<Meta | null> {
  try {
    const meta = JSON.parse(
      await fs.promises.readFile(`${base(projectPath, filterId)}.json`, 'utf8'),
    ) as Meta
    if (
      meta.version !== VERSION ||
      meta.signature !== signature ||
      meta.count !== count
    )
      return null
    const now = new Date()
    await fs.promises.utimes(`${base(projectPath, filterId)}.json`, now, now) // recently used
    return meta
  } catch {
    return null
  }
}

/** The cached row count, without checking the fingerprint (for follow-up chunks). */
export async function cachedCount(
  projectPath: string,
  filterId: string,
): Promise<number | null> {
  try {
    const meta = JSON.parse(
      await fs.promises.readFile(`${base(projectPath, filterId)}.json`, 'utf8'),
    ) as Meta
    return meta.version === VERSION ? meta.count : null
  } catch {
    return null
  }
}

/** Rows [pos, pos + limit) from the cache. */
export async function readCachedChunk(
  projectPath: string,
  filterId: string,
  pos: number,
  limit: number,
  count: number,
): Promise<{ ids: Uint32Array; packed: Uint8Array }> {
  const n = Math.max(0, Math.min(limit, count - pos))
  const ids = new Uint32Array(n)
  const packed = new Uint8Array(n * OVERVIEW_BYTES)
  const b = base(projectPath, filterId)
  const read = async (file: string, buf: Uint8Array, at: number) => {
    const fh = await fs.promises.open(file, 'r')
    try {
      let done = 0
      while (done < buf.length) {
        const { bytesRead } = await fh.read(
          buf,
          done,
          buf.length - done,
          at + done,
        )
        if (!bytesRead) throw new Error('overview cache is truncated')
        done += bytesRead
      }
    } finally {
      await fh.close()
    }
  }
  await read(`${b}.ids`, new Uint8Array(ids.buffer), pos * 4)
  await read(`${b}.packed`, packed, pos * OVERVIEW_BYTES)
  return { ids, packed }
}

type Cursor = { key: number; id: number } | null

const sameCursor = (a: Cursor, b: Cursor) =>
  a === b || (!!a && !!b && a.key === b.key && a.id === b.id)

let writerSeq = 0

/**
 * Collects the chunks of one full read, in order; saved only if the read
 * finishes with exactly the rows the table has. A chunk that doesn't follow on
 * from the last one (a read the renderer gave up on and asked again, or a
 * stale read still running) means the file would be wrong: the caller discards
 * the writer (`follows`).
 */
export class OverviewCacheWriter {
  private ids: fs.WriteStream

  private packed: fs.WriteStream

  count = 0

  private failed = false

  private readonly b: string

  /** This writer's own temporary files (two reads never share them). */
  private readonly tmp: string

  private readonly signature: string

  private readonly expected: number

  /** The cursor the next chunk must start from. */
  private next: Cursor = null

  constructor(
    projectPath: string,
    filterId: string,
    signature: string,
    expected: number,
  ) {
    this.signature = signature
    this.expected = expected
    fs.mkdirSync(cacheDir(), { recursive: true })
    this.b = base(projectPath, filterId)
    writerSeq += 1
    this.tmp = `${this.b}.${process.pid}-${writerSeq}`
    this.ids = fs.createWriteStream(`${this.tmp}.ids.tmp`)
    this.packed = fs.createWriteStream(`${this.tmp}.packed.tmp`)
    const fail = () => {
      this.failed = true
    }
    this.ids.on('error', fail)
    this.packed.on('error', fail)
  }

  /** Whether a chunk read from `cursor` continues this file. */
  follows(cursor: Cursor) {
    return sameCursor(cursor, this.next)
  }

  /** A chunk read from `cursor`; `next` is where the following one starts. */
  append(ids: Uint32Array, packed: Uint8Array, next: Cursor) {
    if (this.failed) return
    this.ids.write(Buffer.from(ids.buffer, ids.byteOffset, ids.byteLength))
    this.packed.write(
      Buffer.from(packed.buffer, packed.byteOffset, packed.byteLength),
    )
    this.count += ids.length
    this.next = next
  }

  async finish() {
    await Promise.all([
      new Promise<void>((resolve) => {
        this.ids.end(() => resolve())
      }),
      new Promise<void>((resolve) => {
        this.packed.end(() => resolve())
      }),
    ])
    if (
      this.failed ||
      this.count < CACHE_MIN_ROWS ||
      this.count !== this.expected
    )
      return this.discard()
    // The old fingerprint must never describe the new files, even for a moment.
    await fs.promises.rm(`${this.b}.json`, { force: true })
    await fs.promises.rename(`${this.tmp}.ids.tmp`, `${this.b}.ids`)
    await fs.promises.rename(`${this.tmp}.packed.tmp`, `${this.b}.packed`)
    const meta: Meta = {
      version: VERSION,
      signature: this.signature,
      count: this.count,
    }
    await fs.promises.writeFile(`${this.b}.json`, JSON.stringify(meta))
    await prune()
    return undefined
  }

  async discard() {
    this.ids.destroy()
    this.packed.destroy()
    for (const ext of ['.ids.tmp', '.packed.tmp'])
      await fs.promises.rm(`${this.tmp}${ext}`, { force: true }).catch(() => {})
  }
}

/** Forget a filter's cached overview (after a reorder). */
export async function invalidateOverview(
  projectPath: string,
  filterId: string,
) {
  const b = base(projectPath, filterId)
  for (const ext of ['.json', '.ids', '.packed'])
    await fs.promises.rm(`${b}${ext}`, { force: true }).catch(() => {})
}

/** Forget every cached overview of a project (removals cascade across its filters). */
export async function invalidateProjectOverviews(projectPath: string) {
  const prefix = path.basename(base(projectPath, 'x')).slice(0, -1) // "<project hash>-"
  const files = await fs.promises
    .readdir(cacheDir())
    .catch(() => [] as string[])
  await Promise.all(
    files
      .filter((f) => f.startsWith(prefix))
      .map((f) =>
        fs.promises
          .rm(path.join(cacheDir(), f), { force: true })
          .catch(() => {}),
      ),
  )
}

/** Keep the folder under CACHE_MAX_BYTES, dropping the least recently used. */
async function prune() {
  const dir = cacheDir()
  const metas = (
    await fs.promises.readdir(dir).catch(() => [] as string[])
  ).filter((f) => f.endsWith('.json'))
  const entries = await Promise.all(
    metas.map(async (f) => {
      const b = path.join(dir, f.slice(0, -5))
      const size = async (ext: string) =>
        (await fs.promises.stat(`${b}${ext}`).catch(() => null))?.size ?? 0
      const used = (await fs.promises.stat(`${b}.json`)).mtimeMs
      return { b, used, bytes: (await size('.ids')) + (await size('.packed')) }
    }),
  )
  entries.sort((a, z) => z.used - a.used)
  let total = 0
  for (const e of entries) {
    total += e.bytes
    if (total > CACHE_MAX_BYTES)
      for (const ext of ['.json', '.ids', '.packed'])
        await fs.promises.rm(`${e.b}${ext}`, { force: true }).catch(() => {})
  }
}
