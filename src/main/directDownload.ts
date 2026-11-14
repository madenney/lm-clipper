/**
 * Direct snapshot downloads: a search's games straight out of the full-database zip
 * (and delta zips of newer games) on storage, by HTTP range requests on a short-lived
 * signed link. No bundle queue, no home uplink, no website in the byte path.
 *
 *   1. The plan: the website's /api/clipper?action=direct-locations pages say where each
 *      game sits (zip, data offset, length, local header offset). They are written to a
 *      compact file in the transfer's folder as they come, so a stopped listing resumes.
 *   2. The download: games sorted by (zip, offset); neighbours within a small gap are
 *      read as one range (on every Fox game, 0.43 requests per game instead of 1).
 *      Each game's local ZIP header is checked (signature, method, sizes) and its
 *      CRC-32 compared before the .slpz is written into the library as it is
 *      (keepDownloadsCompressed, the default) or decoded with the bundled slpz
 *      (.part, then renamed), so a corrupt slice never reaches the library.
 *   3. Resume skips games the library has (by id, or the same recording by hash).
 *      Links are renewed before they run out and on a 403; a zip that changed under
 *      us (412 on If-Match) stops the direct part, and the transfer falls back to the
 *      old paths for whatever is left, as it does for games no zip holds.
 *
 * See apps/database/docs/direct-downloads.md.
 */
import fs, { promises as fsp } from 'fs'
import https from 'https'
import http, { IncomingMessage } from 'http'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import zlib from 'zlib'
import { setTimeout as delay } from 'timers/promises'
import { libraryFileFor, libraryRelativePath } from './replayLibrary'
import { retryFs, retryFsSync } from './fsRetry'
import { userAgentHeaders } from './clientIdentity'
import { encodeSlpzVerified, looksLikeSlpz } from '../lib/slpz'
import type { LibraryAccess } from './replayExtraction'
import type { LibraryEntry } from './replayLibrary'
import { coalesce, type Coalesce, type Range } from '../vendor/direct-plan'

/** One zip as the database describes it. `id` is `<key>@<etag>`. */
export type DirectSnapshot = {
  id: string
  key: string
  etag: string
  size: number
  kind: 'full' | 'delta'
}
export type DirectLink = DirectSnapshot & { url: string }
export type DirectLinks = { links: DirectLink[]; expiresAt: string }

/** One page from /api/clipper?action=direct-locations. */
export type LocationsPage = {
  snapshots: DirectSnapshot[]
  games: [string, string, string, number, number, number, number][]
  other: string[]
  next: string | null
  totals?: { located: number; other: number }
}

// ---------------------------------------------------------------------------
// The plan on disk: plan.json (meta), plan.bin (48-byte records), other.bin (ids).

const RECORD = 48
const ID_BYTES = 12
const ID_RE = /^[0-9a-f]{24}$/
const HASH_RE = /^[0-9a-f]{32}$/

export type PlanMeta = {
  version: 1
  /** Snapshot ids in record order (a record stores its zip's index here). */
  snapshots: DirectSnapshot[]
  /** The next page's cursor (filter listings) or the next id chunk (id lists). */
  cursor: string | null
  chunk: number
  complete: boolean
  count: number
  other: number
  bytes: number
  /** Filled from a prebuilt plan file (prebuiltPlans.ts): its games are all in
   *  `snapshot`; the listing goes on for the selection's other games only. */
  prebuilt?: { snapshot: string; file: string; loaded: boolean }
}

export type PlanEntry = {
  id: string
  /** The database's content hash (32 hex), or '' when it has none in that form. */
  hash: string
  zip: number
  offset: number
  length: number
  header: number
}

function encodeRecord(e: PlanEntry, buf: Buffer, at: number) {
  buf.fill(0, at, at + RECORD)
  buf.write(e.id, at, ID_BYTES, 'hex')
  const hashed = HASH_RE.test(e.hash)
  if (hashed) buf.write(e.hash, at + 12, 16, 'hex')
  buf.writeUInt8(e.zip, at + 28)
  buf.writeUInt8(hashed ? 1 : 0, at + 29)
  buf.writeUInt32LE(e.length, at + 32)
  buf.writeUInt32LE(e.offset - e.header, at + 36)
  buf.writeDoubleLE(e.offset, at + 40)
}

function decodeRecord(buf: Buffer, at: number): PlanEntry {
  const offset = buf.readDoubleLE(at + 40)
  return {
    id: buf.toString('hex', at, at + ID_BYTES),
    hash:
      buf.readUInt8(at + 29) & 1 ? buf.toString('hex', at + 12, at + 28) : '',
    zip: buf.readUInt8(at + 28),
    length: buf.readUInt32LE(at + 32),
    header: offset - buf.readUInt32LE(at + 36),
    offset,
  }
}

/** A plan's files in a folder of the transfer's own. */
export class DirectPlan {
  readonly metaPath: string

  readonly binPath: string

  readonly otherPath: string

  meta: PlanMeta

  constructor(readonly dir: string) {
    this.metaPath = path.join(dir, 'plan.json')
    this.binPath = path.join(dir, 'plan.bin')
    this.otherPath = path.join(dir, 'other.bin')
    this.meta = {
      version: 1,
      snapshots: [],
      cursor: null,
      chunk: 0,
      complete: false,
      count: 0,
      other: 0,
      bytes: 0,
    }
  }

  /** Load what's on disk, cutting the record files back to what the meta vouches for. */
  static open(dir: string): DirectPlan {
    const plan = new DirectPlan(dir)
    fs.mkdirSync(dir, { recursive: true })
    try {
      const meta = JSON.parse(fs.readFileSync(plan.metaPath, 'utf8'))
      if (meta?.version === 1 && Array.isArray(meta.snapshots)) plan.meta = meta
    } catch {
      /* a new plan */
    }
    for (const [file, size] of [
      [plan.binPath, plan.meta.count * RECORD],
      [plan.otherPath, plan.meta.other * ID_BYTES],
    ] as const) {
      if (!fs.existsSync(file)) fs.writeFileSync(file, '')
      if (fs.statSync(file).size !== size) fs.truncateSync(file, size)
    }
    return plan
  }

  private saveMeta() {
    fs.writeFileSync(`${this.metaPath}.tmp`, JSON.stringify(this.meta))
    retryFsSync(
      () => fs.renameSync(`${this.metaPath}.tmp`, this.metaPath),
      `rename ${this.metaPath}.tmp`,
    )
  }

  /** Start again from nothing (a prebuilt plan that stopped half-way in). */
  reset() {
    this.meta = {
      version: 1,
      snapshots: [],
      cursor: null,
      chunk: 0,
      complete: false,
      count: 0,
      other: 0,
      bytes: 0,
    }
    fs.writeFileSync(this.binPath, '')
    fs.writeFileSync(this.otherPath, '')
    this.saveMeta()
  }

  /**
   * Add one page; the meta (with the next cursor) is written after the records.
   * `skipSnapshot`: leave out games in that zip (a prebuilt plan has them already).
   */
  addPage(
    page: LocationsPage,
    next: {
      cursor?: string | null
      chunk?: number
      complete: boolean
      prebuilt?: PlanMeta['prebuilt']
      skipSnapshot?: string
    },
  ) {
    const zipOf = new Map<number, number>()
    page.snapshots.forEach((s, i) => {
      let at = this.meta.snapshots.findIndex((x) => x.id === s.id)
      if (at < 0) {
        this.meta.snapshots.push(s)
        at = this.meta.snapshots.length - 1
      }
      zipOf.set(i, at)
    })
    if (this.meta.snapshots.length > 255)
      throw new Error('Too many zips on storage.')
    let records = Buffer.alloc(page.games.length * RECORD)
    let n = 0
    for (const [id, hash, , zip, offset, length, header] of page.games) {
      if (next.skipSnapshot && page.snapshots[zip]?.id === next.skipSnapshot)
        continue
      const z = zipOf.get(zip)
      if (
        !ID_RE.test(id) ||
        z === undefined ||
        !Number.isSafeInteger(offset) ||
        !Number.isSafeInteger(header) ||
        !(length > 0 && length < 2 ** 32) ||
        !(header >= 0 && header < offset && offset - header < 2 ** 32)
      )
        throw new Error('The database sent an invalid game location.')
      encodeRecord(
        {
          id,
          hash: typeof hash === 'string' ? hash : '',
          zip: z,
          offset,
          length,
          header,
        },
        records,
        n * RECORD,
      )
      n++
      this.meta.bytes += length
    }
    const others = page.other.filter((id) => ID_RE.test(id))
    records = records.subarray(0, n * RECORD)
    if (n) fs.appendFileSync(this.binPath, records)
    if (others.length)
      fs.appendFileSync(this.otherPath, Buffer.from(others.join(''), 'hex'))
    this.meta.count += n
    this.meta.other += others.length
    if (next.cursor !== undefined) this.meta.cursor = next.cursor
    if (next.chunk !== undefined) this.meta.chunk = next.chunk
    if (next.prebuilt) this.meta.prebuilt = next.prebuilt
    this.meta.complete = next.complete
    this.saveMeta()
  }

  entries(): Buffer {
    return fs.readFileSync(this.binPath)
  }

  others(): string[] {
    const buf = fs.readFileSync(this.otherPath)
    const out: string[] = []
    for (let i = 0; i + ID_BYTES <= buf.length; i += ID_BYTES)
      out.push(buf.toString('hex', i, i + ID_BYTES))
    return out
  }
}

// ---------------------------------------------------------------------------
// Coalescing: neighbours read together (shared with the database and the load-test
// tool: packages/direct-plan). Settings measured on production selections in
// apps/database/docs/direct-load-test.md.

export {
  coalesce,
  DEFAULT_COALESCE,
  LEGACY_COALESCE,
  type Coalesce,
  type Range,
} from '../vendor/direct-plan'

// ---------------------------------------------------------------------------
// One entry out of a range: the local header checked, the CRC compared.

export class CorruptEntryError extends Error {}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
/** CRC-32 of a buffer (zlib's, in Electron's Node 22; a table where it's missing). */
export function crc32(data: Buffer): number {
  const native = (zlib as unknown as { crc32?: (_b: Buffer) => number }).crc32
  if (native) return native(data) >>> 0
  let c = 0xffffffff
  for (let i = 0; i < data.length; i++)
    c = CRC_TABLE[(c ^ data[i]) & 255] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** Whether the entry at `at` (its local header) holds a plain .slp rather than a .slpz. */
export function entryIsPlainSlp(buf: Buffer, at: number): boolean {
  const nameLen = buf.readUInt16LE(at + 26)
  return /\.slp$/i.test(buf.toString('utf8', at + 30, at + 30 + nameLen))
}

/** The entry's stored bytes, from a buffer that starts at `bufStart` in the zip. */
export function sliceEntry(
  buf: Buffer,
  bufStart: number,
  e: PlanEntry,
): Buffer {
  const at = e.header - bufStart
  if (at < 0 || e.offset + e.length - bufStart > buf.length)
    throw new CorruptEntryError('The range was cut short.')
  if (buf.readUInt32LE(at) !== 0x04034b50)
    throw new CorruptEntryError('No ZIP entry where the database said.')
  const flags = buf.readUInt16LE(at + 6)
  const method = buf.readUInt16LE(at + 8)
  const crc = buf.readUInt32LE(at + 14)
  const csize = buf.readUInt32LE(at + 18)
  const nameLen = buf.readUInt16LE(at + 26)
  const extraLen = buf.readUInt16LE(at + 28)
  if (method !== 0) throw new CorruptEntryError('The ZIP entry is compressed.')
  if (30 + nameLen + extraLen !== e.offset - e.header)
    throw new CorruptEntryError('The ZIP entry is not where the database said.')
  const data = buf.subarray(e.offset - bufStart, e.offset - bufStart + e.length)
  // Sizes and CRC are in the local header unless a data descriptor follows (bit 3).
  if (!(flags & 8)) {
    if (csize !== 0xffffffff && csize !== e.length)
      throw new CorruptEntryError('The ZIP entry has another size.')
    if (crc32(data) !== crc)
      throw new CorruptEntryError('The replay failed its checksum.')
  }
  return data
}

// ---------------------------------------------------------------------------
// HTTP ranges.

export class LinkExpiredError extends Error {}
/** The zip on storage isn't the one the plan was made from (rebuilt, or gone). */
export class SnapshotChangedError extends Error {}
/** Worth trying again (a busy or failing server, a dropped connection). */
export class TransientRangeError extends Error {
  readonly retryAfterSeconds?: number

  /** No answer at all (a dropped connection), rather than an error status. */
  readonly network: boolean

  constructor(message: string, retryAfterSeconds?: number, network = false) {
    super(message)
    this.retryAfterSeconds = retryAfterSeconds
    this.network = network
  }
}

const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'ENETUNREACH',
  'ENETDOWN',
  'EHOSTUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'UND_ERR_SOCKET',
])

const agents = {
  https: new https.Agent({ keepAlive: true, maxSockets: 64 }),
  http: new http.Agent({ keepAlive: true, maxSockets: 64 }),
}

function open(
  url: URL,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http
    const req = client.request(
      url,
      {
        headers: { ...userAgentHeaders(), ...headers },
        signal,
        agent: url.protocol === 'https:' ? agents.https : agents.http,
      },
      resolve,
    )
    req.setTimeout(60_000, () =>
      req.destroy(
        Object.assign(new Error('Storage stopped answering.'), {
          code: 'ETIMEDOUT',
        }),
      ),
    )
    req.on('error', reject)
    req.end()
  })
}

/** Bytes [start, end) of the zip behind `link`; checks the status, the range and the ETag. */
export async function fetchRange(
  link: DirectLink,
  start: number,
  end: number,
  signal: AbortSignal,
): Promise<Buffer> {
  let res: IncomingMessage
  try {
    res = await open(
      new URL(link.url),
      {
        Range: `bytes=${start}-${end - 1}`,
        'If-Match': `"${link.etag}"`,
        'Accept-Encoding': 'identity',
      },
      signal,
    )
  } catch (error) {
    if (signal.aborted) throw error
    const code = (error as { code?: string }).code
    throw new TransientRangeError(
      (error as Error).message || 'Storage could not be reached.',
      undefined,
      !code || NETWORK_CODES.has(code),
    )
  }
  const status = res.statusCode || 0
  if (status !== 206) {
    res.resume()
    if (status === 401 || status === 403)
      throw new LinkExpiredError('The storage link expired.')
    if (status === 412 || status === 404)
      throw new SnapshotChangedError(
        'The full-database file changed on storage.',
      )
    if (status === 429 || status >= 500) {
      const retry = Number(res.headers['retry-after'])
      throw new TransientRangeError(
        `Storage answered ${status}.`,
        Number.isFinite(retry) ? retry : undefined,
      )
    }
    throw new Error(`Storage answered ${status} to a range request.`)
  }
  const etag = String(res.headers.etag ?? '')
    .replace(/^W\//, '')
    .replace(/"/g, '')
  if (etag && etag !== link.etag) {
    res.resume()
    throw new SnapshotChangedError('The full-database file changed on storage.')
  }
  const m = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(
    String(res.headers['content-range'] ?? ''),
  )
  if (!m || Number(m[1]) !== start || Number(m[2]) !== end - 1) {
    res.resume()
    throw new TransientRangeError('Storage sent the wrong range.')
  }
  const out = Buffer.allocUnsafe(end - start)
  let at = 0
  try {
    for await (const chunk of res as AsyncIterable<Buffer>) {
      if (at + chunk.length > out.length)
        throw new TransientRangeError('Storage sent too much.')
      chunk.copy(out, at)
      at += chunk.length
    }
  } catch (error) {
    if (signal.aborted) throw error
    if (error instanceof TransientRangeError) throw error
    throw new TransientRangeError(
      (error as Error).message || 'The download was cut off.',
      undefined,
      true,
    )
  }
  if (at !== out.length)
    throw new TransientRangeError('The download was cut off.', undefined, true)
  return out
}

// ---------------------------------------------------------------------------
// Decoding with the bundled slpz.

/** Decode one .slpz (fed on stdin) to `target`, which must not exist yet. */
export function decodeSlpz(
  binary: string,
  slpz: Buffer,
  target: string,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['-d', '-q', '-o', target, '-'], {
      stdio: ['pipe', 'ignore', 'pipe'],
      windowsHide: true,
      signal,
    })
    let stderr = ''
    child.stderr.on('data', (d) => {
      stderr += String(d).slice(0, 500)
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000)
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', async (code) => {
      clearTimeout(timer)
      // slpz exits 0 even when it can't decode: check what it wrote.
      try {
        const fd = await fsp.open(target, 'r')
        const head = Buffer.alloc(8)
        const { bytesRead } = await fd.read(head, 0, 8, 0)
        await fd.close()
        if (
          code === 0 &&
          !stderr.trim() &&
          bytesRead === 8 &&
          head.toString('latin1', 0, 6) === '{U\x03raw'
        )
          return resolve()
      } catch {
        /* nothing written */
      }
      await fsp.rm(target, { force: true }).catch(() => {})
      reject(
        new CorruptEntryError(
          `The replay could not be decoded${stderr.trim() ? `: ${stderr.trim()}` : '.'}`,
        ),
      )
    })
    child.stdin.on('error', () => {})
    child.stdin.end(slpz)
  })
}

/** A tiny counting semaphore. */
class Gate {
  private waiting: (() => void)[] = []

  private active = 0

  private max: number

  constructor(max: number) {
    this.max = max
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max)
      await new Promise<void>((resolve) => {
        this.waiting.push(resolve)
      })
    this.active++
    try {
      return await fn()
    } finally {
      this.active--
      this.waiting.shift()?.()
    }
  }
}

// ---------------------------------------------------------------------------
// The download.

export type DirectProgress = {
  /** Games in the library (fetched now or before) out of the plan. */
  done: number
  total: number
  /** Bytes read from storage (this run), range requests made, bytes a second lately. */
  bytes: number
  requests: number
  bytesPerSec: number | null
}

export type DirectOptions = {
  plan: DirectPlan
  library: LibraryAccess
  slpzBinary: string
  /** Current links; renew() asks for fresh ones (single-flight inside). */
  links: { current: () => DirectLinks; renew: () => Promise<DirectLinks> }
  signal: AbortSignal
  onProgress?: (_p: DirectProgress) => void
  /** Parallel range requests (default 16, at most 32). */
  concurrency?: number
  /** Parallel decoders (default half the cores, 2 to 8). */
  decoders?: number
  coalesce?: Coalesce
  /** Tests: the retry wait (ms) for attempt n. */
  backoffMs?: (_attempt: number) => number
  /** Tests substitute a local server; production allows only our storage host. */
  allowUrl?: (_url: string) => boolean
}

export type DirectResult = {
  /** Library paths of every plan game now in the library. */
  files: string[]
  /** Plan games that couldn't be read or decoded (for the old path). */
  failed: string[]
  requests: number
  bytes: number
  /** Games written this run. */
  fetched: number
}

/** Network errors are waited out this many times (2, 4, 8, 16, then 30 s apart: ~2.5 min). */
const NETWORK_ATTEMPTS = 9
/** A busy or failing server: this many tries per range, then its games go to the old path. */
const SERVER_ATTEMPTS = 6
/** Renew links this long before they run out. */
const RENEW_EARLY_MS = 3 * 60 * 1000
/** A replay bigger than this as .slpz is a runaway recording: left to the old path (which refuses it too). */
const MAX_ENTRY_BYTES = 32 * 1024 * 1024

/** Games a download may skip because a file stayed locked after the retries. */
const MAX_FILE_LOCKS = 25

/** A file operation that still fails with EPERM/EBUSY/EACCES after retryFs
 *  (a lock on one file, as opposed to a full drive or a missing folder). */
const isStubbornFileLock = (error: unknown): boolean => {
  const code = (error as { code?: string } | null)?.code
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES'
}

export async function runDirectDownload(
  o: DirectOptions,
): Promise<DirectResult> {
  const { plan, library, signal } = o
  const buf = plan.entries()
  const n = Math.floor(buf.length / RECORD)
  const entries: PlanEntry[] = new Array(n)
  for (let i = 0; i < n; i++) entries[i] = decodeRecord(buf, i * RECORD)
  // (zip, offset) order: offsets < 2^41 and zips < 256 fit one exact double.
  const keys = new Float64Array(n)
  for (let i = 0; i < n; i++)
    keys[i] = entries[i].zip * 2 ** 42 + entries[i].offset
  const order = new Uint32Array(n)
  for (let i = 0; i < n; i++) order[i] = i
  order.sort((a, b) => keys[a] - keys[b])

  // What the library has: these are done (resume), and a recording it has under
  // another id is remembered under this one too.
  const done = new Uint8Array(n)
  const files: string[] = []
  const failed: string[] = []
  const pending: LibraryEntry[] = []
  for (let s = 0; s < n; s += 2000) {
    const slice = entries.slice(s, s + 2000)
    const { have, haveHashes } = await library.lookup(
      slice.map((e) => e.id),
      slice.map((e) => e.hash).filter(Boolean),
    )
    slice.forEach((e, k) => {
      const existing = have[e.id] || (e.hash && haveHashes[e.hash])
      if (!existing) return
      done[s + k] = 1
      files.push(existing)
      if (!have[e.id])
        pending.push({ replayId: e.id, fileHash: e.hash, path: existing })
    })
    if (signal.aborted) throw new Error('Paused')
  }
  let doneCount = files.length
  let bytes = 0
  let requests = 0
  let fetched = 0
  let lastFlush = Date.now()
  const flush = async (force = false) => {
    if (
      !pending.length ||
      (!force && pending.length < 200 && Date.now() - lastFlush < 2000)
    )
      return
    lastFlush = Date.now()
    await library.register(pending.splice(0))
  }
  await flush(true)

  const samples: { t: number; b: number }[] = []
  let lastReport = 0
  const report = (force = false) => {
    const now = Date.now()
    if (!force && now - lastReport < 250) return
    lastReport = now
    samples.push({ t: now, b: bytes })
    while (samples.length > 2 && now - samples[0].t > 10_000) samples.shift()
    const a = samples[0]
    const rate = now - a.t > 1500 ? ((bytes - a.b) * 1000) / (now - a.t) : null
    o.onProgress?.({
      done: doneCount,
      total: n,
      bytes,
      requests,
      bytesPerSec: rate,
    })
  }
  report(true)

  // One renewal at a time, whoever notices first.
  let renewing: Promise<DirectLinks> | null = null
  const renew = () => {
    renewing ??= o.links.renew().finally(() => {
      renewing = null
    })
    return renewing
  }
  const linkFor = async (zip: number): Promise<DirectLink> => {
    let set = renewing ? await renewing : o.links.current()
    if (Date.parse(set.expiresAt) - Date.now() < RENEW_EARLY_MS)
      set = await renew()
    const snap = plan.meta.snapshots[zip]
    const link = set.links.find((l) => l.id === snap?.id)
    if (!link)
      throw new SnapshotChangedError('That zip is no longer on storage.')
    if (o.allowUrl && !o.allowUrl(link.url))
      throw new Error('The database returned an unsupported download host.')
    return link
  }

  const backoff = o.backoffMs ?? ((a: number) => Math.min(2 ** a, 30) * 1000)
  /** Read a range, waiting out network trouble and busy servers; renews expired links. */
  const read = async (
    zip: number,
    start: number,
    end: number,
  ): Promise<Buffer> => {
    let renewals = 0
    for (let attempt = 1; ; attempt++) {
      if (signal.aborted) throw new Error('Paused')
      let used: string | null = null
      try {
        const link = await linkFor(zip)
        used = link.url
        requests++
        return await fetchRange(link, start, end, signal)
      } catch (error) {
        if (signal.aborted) throw new Error('Paused')
        if (error instanceof LinkExpiredError) {
          // Renewed meanwhile by another request: just use the new link.
          const now = (
            renewing ? await renewing : o.links.current()
          ).links.find((l) => l.id === plan.meta.snapshots[zip]?.id)
          if (!now || now.url === used) {
            if (++renewals > 3)
              throw new Error('Storage keeps refusing the download link.')
            await renew()
          }
          attempt--
          continue
        }
        if (!(error instanceof TransientRangeError)) throw error
        if (attempt >= (error.network ? NETWORK_ATTEMPTS : SERVER_ATTEMPTS))
          throw error
        const wait = error.retryAfterSeconds
          ? Math.min(error.retryAfterSeconds, 60) * 1000
          : backoff(attempt)
        await delay(wait, undefined, { signal }).catch(() => {})
      }
    }
  }

  // Decoding is the slow part once the line is fast (~10 ms of CPU a game).
  const decoders = new Gate(
    Math.max(
      1,
      o.decoders ?? Math.min(8, Math.max(2, Math.floor(os.cpus().length / 2))),
    ),
  )
  /** Write one game into the library from its stored bytes. */
  const save = async (e: PlanEntry, data: Buffer, format: 'slpz' | 'slp') => {
    let target = libraryFileFor(library.folder, e.id)
    if (!target) {
      // Kept compressed (the default): the .slpz bytes go to disk as they
      // are, no decode. A plain .slp entry is compressed when that gives the
      // same bytes back (lib/slpz.ts), else kept as .slp.
      let stored: Buffer | null = null
      let ext: '.slp' | '.slpz' = '.slp'
      if (format === 'slp') {
        if (data.toString('latin1', 0, 6) !== '{U\x03raw')
          throw new CorruptEntryError('The download was not a replay file.')
        stored = (library.compress && encodeSlpzVerified(data)) || data
        ext = stored === data ? '.slp' : '.slpz'
      } else if (library.compress) {
        if (!looksLikeSlpz(data))
          throw new CorruptEntryError('The download was not a .slpz replay.')
        stored = data
        ext = '.slpz'
      }
      target = path.join(library.folder, libraryRelativePath(e.id, ext))
      await fsp.mkdir(path.dirname(target), { recursive: true })
      const part = `${target}.part`
      // Defender, the indexer or OneDrive often hold a freshly written file for a
      // moment: retried (launch review DL-5 / WIN-5), not a failed transfer.
      await retryFs(() => fsp.rm(part, { force: true }), `rm ${part}`)
      if (stored)
        await retryFs(
          () => fsp.writeFile(part, stored as Buffer, { flag: 'wx' }),
          `write ${part}`,
        )
      else
        await decoders.run(() => decodeSlpz(o.slpzBinary, data, part, signal))
      const placed = target
      await retryFs(() => fsp.rename(part, placed), `rename ${part}`)
    }
    pending.push({ replayId: e.id, fileHash: e.hash, path: target })
    files.push(target)
    doneCount++
    fetched++
  }

  /** A range's bytes, or null when the server kept failing it (its games go to the old path). */
  const fetchPart = async (r: Range): Promise<Buffer | null> => {
    try {
      const data = await read(r.zip, r.start, r.end)
      bytes += data.length
      return data
    } catch (error) {
      if (error instanceof TransientRangeError && !error.network) {
        for (const i of r.items) failed.push(entries[i].id)
        return null
      }
      throw error
    }
  }

  let fileLocks = 0
  /** One range read alone (a corrupt entry's second chance). */
  const handle = async (r: Range, alone = false) => {
    const data = await fetchPart(r)
    if (data) await processPart(r, data, alone)
  }

  /** Every entry of a fetched range checked and saved; bad entries retried alone once. */
  const processPart = async (r: Range, data: Buffer, alone = false) => {
    // The range's games decode side by side (the decoders gate bounds it).
    await Promise.all(
      r.items.map(async (i) => {
        if (signal.aborted) throw new Error('Paused')
        const e = entries[i]
        try {
          const slice = sliceEntry(data, r.start, e)
          await save(
            e,
            slice,
            entryIsPlainSlp(data, e.header - r.start) ? 'slp' : 'slpz',
          )
        } catch (error) {
          if (signal.aborted) throw new Error('Paused')
          if (isStubbornFileLock(error) && ++fileLocks <= MAX_FILE_LOCKS) {
            // Still locked after the retries: this game goes to the "couldn't
            // be read" list (Resume fetches it again) instead of ending the
            // whole transfer. A folder that refuses everything still stops it.
            failed.push(e.id)
          } else if (!(error instanceof CorruptEntryError)) throw error
          else if (alone) failed.push(e.id)
          else
            await handle(
              {
                zip: e.zip,
                start: e.header,
                end: e.offset + e.length,
                items: [i],
              },
              true,
            )
        }
        done[i] = 1
        report()
      }),
    )
    await flush()
  }

  const ranges = coalesce(
    entries,
    order,
    (i) => {
      if (done[i]) return true
      if (entries[i].length > MAX_ENTRY_BYTES) {
        failed.push(entries[i].id)
        done[i] = 1
        return true
      }
      return false
    },
    o.coalesce,
  )
  let failure: unknown = null
  // Fetching never waits for decoding: each worker hands its range to the
  // decoders and asks for the next one, up to this many bytes waiting.
  const MAX_PENDING_BYTES = 128 * 1024 * 1024
  let pendingBytes = 0
  const decoding = new Set<Promise<void>>()
  const fail = (error: unknown) => {
    failure ??= error
  }
  /** Decode a fetched range in the background (tracked, its bytes counted while it waits). */
  const startDecoding = (r: Range, data: Buffer) => {
    pendingBytes += data.length
    const job: Promise<void> = processPart(r, data)
      .catch(fail)
      .finally(() => {
        pendingBytes -= data.length
        decoding.delete(job)
      })
    decoding.add(job)
  }
  const tooMuchWaiting = () =>
    pendingBytes > MAX_PENDING_BYTES && decoding.size > 0
  const worker = async () => {
    for (;;) {
      if (failure || signal.aborted) return
      // eslint-disable-next-line no-await-in-loop
      while (tooMuchWaiting()) await Promise.race(decoding)
      const next = ranges.next()
      if (next.done) return
      try {
        // eslint-disable-next-line no-await-in-loop
        const data = await fetchPart(next.value)
        if (data) startDecoding(next.value, data)
      } catch (error) {
        fail(error)
        return
      }
    }
  }
  const width = Math.max(1, Math.min(32, o.concurrency ?? 16))
  await Promise.all(Array.from({ length: width }, worker))
  await Promise.all([...decoding])
  await flush(true).catch(() => {})
  report(true)
  if (signal.aborted) throw new Error('Paused')
  if (failure) throw failure
  return { files, failed, requests, bytes, fetched }
}

/** Ids of plan games (for falling back when the direct part can't go on). */
export function planIds(plan: DirectPlan): string[] {
  const buf = plan.entries()
  const out: string[] = []
  for (let i = 0; i + RECORD <= buf.length; i += RECORD)
    out.push(buf.toString('hex', i, i + ID_BYTES))
  return out
}

// ---------------------------------------------------------------------------
// The listing.

/** Ids per locations request for an explicit list (and games per page). */
export const ID_CHUNK = 5000

/**
 * Fill `plan` from the locations pages (resuming where it stopped). `spec` is a
 * Find-replays filter body, or a list of replay ids sent ID_CHUNK at a time.
 */
export async function buildPlan(
  plan: DirectPlan,
  spec: { filter: Record<string, unknown> } | { replayIds: string[] },
  fetchPage: (_body: Record<string, unknown>) => Promise<LocationsPage>,
  signal: AbortSignal,
  onPage?: (_meta: PlanMeta) => void,
): Promise<void> {
  while (!plan.meta.complete) {
    if (signal.aborted) throw new Error('Paused')
    const cursor = plan.meta.cursor ? { cursor: plan.meta.cursor } : {}
    if ('filter' in spec) {
      // After a prebuilt plan: only the selection's games outside its zip (all of
      // them: the prebuilt plan already is the whole selection there). A website or
      // database that doesn't know exceptSnapshot sends everything; those rows are
      // dropped here, so the plan is the same either way.
      const prebuilt = plan.meta.prebuilt?.loaded
        ? plan.meta.prebuilt.snapshot
        : undefined
      let filter = spec.filter
      if (prebuilt) {
        const { maxFiles: _all, ...rest } = spec.filter
        filter = { ...rest, exceptSnapshot: prebuilt }
      }
      const page = await fetchPage({
        ...filter,
        ...cursor,
        limit: ID_CHUNK,
      })
      plan.addPage(page, {
        cursor: page.next,
        complete: !page.next,
        skipSnapshot: prebuilt,
      })
    } else {
      const ids = spec.replayIds.slice(
        plan.meta.chunk * ID_CHUNK,
        (plan.meta.chunk + 1) * ID_CHUNK,
      )
      if (!ids.length) {
        plan.addPage(
          { snapshots: [], games: [], other: [], next: null },
          { complete: true },
        )
        break
      }
      const page = await fetchPage({
        replayIds: ids,
        includeCpu: true,
        ...cursor,
        limit: ID_CHUNK,
      })
      const last = (plan.meta.chunk + 1) * ID_CHUNK >= spec.replayIds.length
      plan.addPage(
        page,
        page.next
          ? { cursor: page.next, complete: false }
          : { cursor: null, chunk: plan.meta.chunk + 1, complete: last },
      )
    }
    onPage?.(plan.meta)
  }
}
