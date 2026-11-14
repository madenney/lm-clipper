/**
 * @jest-environment node
 *
 * Direct snapshot downloads against a fake storage server: a real stored zip of
 * .slpz entries served with Range / If-Match / ETag like R2. Coalescing, resume,
 * link expiry, corrupt slices, a rebuilt zip, the listing, and the transfer
 * manager's direct path with its fallback to the old paths.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import crypto from 'crypto'
import zlib from 'zlib'
import { execFileSync } from 'child_process'
import {
  DirectPlan,
  SnapshotChangedError,
  buildPlan,
  coalesce,
  crc32,
  runDirectDownload,
  sliceEntry,
  CorruptEntryError,
  type DirectLinks,
  type LocationsPage,
  type PlanEntry,
} from '../main/directDownload'
import { libraryRelativePath } from '../main/replayLibrary'
import { _resetManifestCache } from '../main/prebuiltPlans'
import { encodePlanFile } from '../vendor/direct-plan'
import { decodeSlpz } from '../lib/slpz'
import type { LibraryAccess } from '../main/replayExtraction'

jest.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => os.tmpdir(),
    getVersion: () => '3.0.0-test',
  },
  dialog: {},
  shell: {},
}))

// eslint-disable-next-line import/first
import TransferManager from '../main/managers/TransferManager'
// eslint-disable-next-line import/first
import { DatabaseRequestError } from '../main/databaseClient'

const SLPZ = path.resolve(__dirname, '../../release/app/slpz/slpz-linux-x64')
const REPLAY = path.resolve(__dirname, '../../assets/test.slp')
const canRun =
  process.platform === 'linux' && fs.existsSync(SLPZ) && fs.existsSync(REPLAY)
const maybe = canRun ? describe : describe.skip

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex')
const id = (n: number) => n.toString(16).padStart(24, '0')
const hash = (n: number) => n.toString(16).padStart(32, 'f')

/** A stored zip like the full DB: name, CRC and sizes in each local header, no extra fields. */
function buildZip(entries: { name: string; data: Buffer }[]) {
  const parts: Buffer[] = []
  const central: Buffer[] = []
  const located: {
    name: string
    header: number
    offset: number
    length: number
  }[] = []
  let at = 0
  for (const e of entries) {
    const name = Buffer.from(e.name)
    const h = Buffer.alloc(30)
    h.writeUInt32LE(0x04034b50, 0)
    h.writeUInt16LE(20, 4)
    h.writeUInt32LE(crc32(e.data), 14)
    h.writeUInt32LE(e.data.length, 18)
    h.writeUInt32LE(e.data.length, 22)
    h.writeUInt16LE(name.length, 26)
    located.push({
      name: e.name,
      header: at,
      offset: at + 30 + name.length,
      length: e.data.length,
    })
    const c = Buffer.alloc(46)
    c.writeUInt32LE(0x02014b50, 0)
    c.writeUInt32LE(crc32(e.data), 16)
    c.writeUInt32LE(e.data.length, 20)
    c.writeUInt32LE(e.data.length, 24)
    c.writeUInt16LE(name.length, 28)
    c.writeUInt32LE(at, 42)
    central.push(c, name)
    parts.push(h, name, e.data)
    at += 30 + name.length + e.data.length
  }
  const cd = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(at, 16)
  return { zip: Buffer.concat([...parts, cd, end]), located }
}

/** R2 in miniature: ranges on a signed path, ETag + If-Match, and knobs for trouble. */
function fakeStorage(zip: Buffer, etag: string) {
  const state = {
    requests: 0,
    ranges: [] as [number, number][],
    validToken: 'tok1',
    /** Corrupt one byte of the next N responses. */
    corruptNext: 0,
    /** Corrupt this byte offset in every response that covers it. */
    corruptAt: -1,
    /** Answer the next N with 500. */
    failNext: 0,
    etag,
    body: zip,
    onRange: null as null | (() => void),
    /** Answer ranges this much later (ms). */
    delayMs: 0,
  }
  const server = http.createServer((req, res) => {
    state.requests++
    const url = new URL(req.url!, 'http://x')
    if (url.searchParams.get('token') !== state.validToken) {
      res.writeHead(403).end('<Error><Code>AccessDenied</Code></Error>')
      return
    }
    if (
      req.headers['if-match'] &&
      req.headers['if-match'] !== `"${state.etag}"`
    ) {
      res.writeHead(412).end()
      return
    }
    if (state.failNext > 0) {
      state.failNext--
      res.writeHead(500).end()
      return
    }
    const m = /^bytes=(\d+)-(\d+)$/.exec(String(req.headers.range))
    if (!m) {
      res.writeHead(200, { ETag: `"${state.etag}"` }).end(state.body)
      return
    }
    const s = Number(m[1])
    const e = Math.min(Number(m[2]), state.body.length - 1)
    state.ranges.push([s, e + 1])
    state.onRange?.()
    let out = Buffer.from(state.body.subarray(s, e + 1))
    if (state.corruptNext > 0) {
      state.corruptNext--
      out[out.length - 5] ^= 0xff
    }
    if (state.corruptAt >= s && state.corruptAt <= e) {
      out = Buffer.from(out)
      out[state.corruptAt - s] ^= 0xff
    }
    const send = () => {
      res.writeHead(206, {
        ETag: `"${state.etag}"`,
        'Content-Range': `bytes ${s}-${e}/${state.body.length}`,
        'Content-Length': String(out.length),
      })
      res.end(out)
    }
    if (state.delayMs) setTimeout(send, state.delayMs)
    else send()
  })
  return { server, state }
}

function fakeLibrary(folder: string) {
  const rows = new Map<string, { fileHash: string; path: string }>()
  const lib: LibraryAccess & { rows: typeof rows } = {
    folder,
    rows,
    lookup: async (replayIds, fileHashes) => {
      const have: Record<string, string> = {}
      const haveHashes: Record<string, string> = {}
      for (const rid of replayIds) {
        const row = rows.get(rid)
        if (row && fs.existsSync(row.path)) have[rid] = row.path
      }
      for (const row of rows.values())
        if (
          row.fileHash &&
          fileHashes.includes(row.fileHash) &&
          fs.existsSync(row.path)
        )
          haveHashes[row.fileHash] ??= row.path
      return { have, haveHashes, missing: replayIds.filter((x) => !have[x]) }
    },
    register: async (entries) => {
      for (const e of entries)
        rows.set(e.replayId, { fileHash: e.fileHash, path: e.path })
      return entries.length
    },
  }
  return lib
}

describe('coalesce', () => {
  const e = (zip: number, header: number, length: number): PlanEntry => ({
    id: id(header),
    hash: '',
    zip,
    header,
    offset: header + 50,
    length,
  })
  it('joins neighbours within the gap, size and count budgets, never across zips', () => {
    const entries = [
      e(0, 0, 100), // 0..150
      e(0, 150, 100), // touching
      e(0, 300, 100), // 50-byte gap
      e(0, 10_000, 100), // far
      e(1, 10_150, 100), // other zip
      e(0, 10_150, 5000), // would make the range too big
    ]
    const order = [0, 1, 2, 3, 5, 4]
    const ranges = [
      ...coalesce(entries, order, () => false, {
        maxGap: 64,
        maxBytes: 2000,
        maxGames: 10,
      }),
    ]
    expect(ranges.map((r) => [r.zip, r.start, r.end, r.items])).toEqual([
      [0, 0, 450, [0, 1, 2]],
      [0, 10_000, 10_150, [3]],
      [0, 10_150, 15_200, [5]],
      [1, 10_150, 10_300, [4]],
    ])
    // Skipped entries (already in the library) are left out; at most maxGames each.
    const two = [
      ...coalesce(entries, [0, 1, 2], (i) => i === 1, {
        maxGap: 64,
        maxBytes: 1e6,
        maxGames: 1,
      }),
    ]
    expect(two.map((r) => r.items)).toEqual([[0], [2]])
  })
})

maybe('direct snapshot downloads', () => {
  let dir: string
  let original: Buffer
  let slpz: Buffer
  let zip: Buffer
  let located: {
    name: string
    header: number
    offset: number
    length: number
  }[]
  let storage: ReturnType<typeof fakeStorage>
  let base: string
  const ETAG = 'abc123-7'
  const SNAP = {
    id: `archive/lunar_db_full.zip@${ETAG}`,
    key: 'archive/lunar_db_full.zip',
    etag: ETAG,
    size: 0,
    kind: 'full' as const,
  }
  /** Entries 0..9 are wanted games, f* fillers between them (other games in the zip). */
  const WANTED = 10

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lunar-direct-'))
    original = fs.readFileSync(REPLAY)
    execFileSync(SLPZ, ['-x', '-q', '-o', path.join(dir, 'g.slpz'), REPLAY])
    slpz = fs.readFileSync(path.join(dir, 'g.slpz'))
    const entries: { name: string; data: Buffer }[] = []
    for (let i = 0; i < WANTED; i++) {
      entries.push({ name: `netplay/A/Game_${i}.slpz`, data: slpz })
      // A small filler after every other game (read through), a big one after game 5 (a gap).
      if (i % 2 === 1)
        entries.push({
          name: `netplay/A/f${i}.slpz`,
          data: Buffer.alloc(1000, i),
        })
      if (i === 5)
        entries.push({
          name: 'netplay/A/big.slpz',
          data: Buffer.alloc(600_000, 7),
        })
    }
    entries.push({ name: 'netplay/A/plain.slp', data: original }) // a replay stored as plain .slp
    ;({ zip, located } = buildZip(entries))
    SNAP.size = zip.length
    storage = fakeStorage(zip, ETAG)
    await new Promise<void>((resolve) => {
      storage.server.listen(0, '127.0.0.1', () => resolve())
    })
    base = `http://127.0.0.1:${(storage.server.address() as { port: number }).port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      storage.server.close(() => resolve())
    })
    fs.rmSync(dir, { recursive: true, force: true })
  })

  beforeEach(() => {
    Object.assign(storage.state, {
      requests: 0,
      ranges: [],
      validToken: 'tok1',
      corruptNext: 0,
      corruptAt: -1,
      failNext: 0,
      etag: ETAG,
      body: zip,
      onRange: null,
      delayMs: 0,
    })
  })

  /** The locations page the database would send for the wanted games (+ the plain one). */
  function page(): LocationsPage {
    const games = located
      .filter((l) => /Game_\d+\.slpz$|plain\.slp$/.test(l.name))
      .map(
        (l, k) =>
          [
            id(k + 1),
            hash(k + 1),
            path.basename(l.name),
            0,
            l.offset,
            l.length,
            l.header,
          ] as LocationsPage['games'][0],
      )
    return { snapshots: [SNAP], games, other: [id(500)], next: null }
  }

  function newPlan(name: string) {
    const plan = DirectPlan.open(path.join(dir, name))
    plan.addPage(page(), { cursor: null, complete: true })
    return plan
  }

  const linksWith = (token: string): DirectLinks => ({
    links: [
      {
        ...SNAP,
        url: `${base}/lm-replays/archive/lunar_db_full.zip?token=${token}`,
      },
    ],
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  })

  function run(
    plan: DirectPlan,
    library: ReturnType<typeof fakeLibrary>,
    opts: {
      signal?: AbortSignal
      renew?: () => Promise<DirectLinks>
      onProgress?: (_p: any) => void
      oneByOne?: boolean
    } = {},
  ) {
    let links = linksWith('tok1')
    return runDirectDownload({
      plan,
      library,
      slpzBinary: SLPZ,
      links: {
        current: () => links,
        renew: async () => {
          links = await (opts.renew ?? (async () => linksWith('tok1')))()
          return links
        },
      },
      signal: opts.signal ?? new AbortController().signal,
      concurrency: opts.oneByOne ? 1 : 4,
      ...(opts.oneByOne
        ? { coalesce: { maxGap: 0, maxBytes: 1e9, maxGames: 1 } }
        : {}),
      backoffMs: () => 5,
      onProgress: opts.onProgress,
    })
  }

  it('reads neighbours together and decodes every game byte for byte into the library', async () => {
    const library = fakeLibrary(path.join(dir, 'lib1'))
    const plan = newPlan('plan1')
    const progress: any[] = []
    const result = await run(plan, library, {
      onProgress: (p) => progress.push(p),
    })
    expect(result.failed).toEqual([])
    expect(result.files).toHaveLength(WANTED + 1)
    for (let k = 1; k <= WANTED + 1; k++) {
      const file = path.join(library.folder, libraryRelativePath(id(k)))
      expect(sha(fs.readFileSync(file))).toBe(sha(original))
      expect(library.rows.get(id(k))).toEqual({ fileHash: hash(k), path: file })
    }
    // 11 games: the 600 KB filler splits them into two runs; small fillers are read through.
    expect(storage.state.requests).toBe(2)
    expect(result.requests).toBe(2)
    expect(progress.at(-1)).toMatchObject({
      done: WANTED + 1,
      total: WANTED + 1,
      requests: 2,
    })
    // Nothing left behind but replays.
    const walk = (d: string): string[] =>
      fs
        .readdirSync(d, { withFileTypes: true })
        .flatMap((x) =>
          x.isDirectory() ? walk(path.join(d, x.name)) : [x.name],
        )
    expect(walk(library.folder).filter((f) => f.endsWith('.part'))).toEqual([])
  })

  it('keeps games compressed: the .slpz bytes go to disk as they are, a plain .slp is compressed', async () => {
    const library = {
      ...fakeLibrary(path.join(dir, 'libz')),
      compress: true,
    }
    const plan = newPlan('planz')
    const result = await run(plan, library as any)
    expect(result.failed).toEqual([])
    expect(result.files).toHaveLength(WANTED + 1)
    for (let k = 1; k <= WANTED; k++) {
      const file = path.join(
        library.folder,
        libraryRelativePath(id(k), '.slpz'),
      )
      expect(fs.readFileSync(file).equals(slpz)).toBe(true)
      expect(library.rows.get(id(k))?.path).toBe(file)
    }
    // The plain .slp entry: stored as a .slpz that decodes to the same bytes.
    const plainFile = library.rows.get(id(WANTED + 1))!.path
    expect(plainFile.endsWith('.slpz')).toBe(true)
    expect(decodeSlpz(fs.readFileSync(plainFile)).equals(original)).toBe(true)
    // Run again: everything is had, in whichever form it was stored.
    const again = await run(DirectPlan.open(path.join(dir, 'planz')), {
      ...library,
    } as any)
    expect(again.fetched).toBe(0)
  })

  it('resumes: games already in the library (by id or by hash) are not fetched again', async () => {
    const library = fakeLibrary(path.join(dir, 'lib2'))
    const plan = newPlan('plan2')
    const abort = new AbortController()
    // Stopped (Pause, or Clipper closing) while the 5th game is being read.
    storage.state.delayMs = 60
    storage.state.onRange = () => {
      if (storage.state.ranges.length >= 5) abort.abort()
    }
    await expect(
      run(plan, library, { signal: abort.signal, oneByOne: true }),
    ).rejects.toThrow(/Paused/)
    storage.state.onRange = null
    storage.state.delayMs = 0
    const had = library.rows.size
    expect(had).toBeGreaterThanOrEqual(3)
    expect(had).toBeLessThan(WANTED + 1)
    // The plain-.slp game's recording is in the library already under another id.
    const elsewhere = path.join(library.folder, 'mine.slp')
    fs.writeFileSync(elsewhere, original)
    await library.register([
      { replayId: id(999), fileHash: hash(WANTED + 1), path: elsewhere },
    ])
    const reopened = DirectPlan.open(path.join(dir, 'plan2'))
    storage.state.ranges = []
    const result = await run(reopened, library)
    expect(result.failed).toEqual([])
    expect(result.files).toHaveLength(WANTED + 1)
    // Only the games still missing were fetched; the plain one counts as had (by hash).
    const plain = located.find((l) => l.name.endsWith('plain.slp'))!
    expect(result.fetched).toBe(WANTED + 1 - had - 1)
    expect(
      storage.state.ranges.some(
        ([a, b]) => a <= plain.header && plain.offset < b,
      ),
    ).toBe(false)
    expect(library.rows.get(id(WANTED + 1))?.path).toBe(elsewhere)
    for (const [a] of storage.state.ranges) {
      // Nothing already in the library was read again.
      const g = located.find((l) => l.header === a)!
      const k =
        located
          .filter((l) => /Game_\d+\.slpz$|plain\.slp$/.test(l.name))
          .indexOf(g) + 1
      expect(k).toBeGreaterThan(0)
    }
  })

  it('renews an expired link and carries on', async () => {
    const library = fakeLibrary(path.join(dir, 'lib3'))
    const plan = newPlan('plan3')
    storage.state.validToken = 'tok2' // tok1 has "expired"
    let renewals = 0
    const result = await run(plan, library, {
      renew: async () => {
        renewals++
        return linksWith('tok2')
      },
    })
    expect(renewals).toBe(1) // single-flight: one renewal for every waiting worker
    expect(result.files).toHaveLength(WANTED + 1)
  })

  it('a corrupt slice is read again on its own; a game corrupt on storage goes to the old path', async () => {
    const library = fakeLibrary(path.join(dir, 'lib4'))
    const plan = newPlan('plan4')
    storage.state.corruptNext = 1 // one bad response in flight
    const ok = await run(plan, library)
    expect(ok.failed).toEqual([])
    expect(ok.files).toHaveLength(WANTED + 1)

    const library2 = fakeLibrary(path.join(dir, 'lib4b'))
    const plan2 = newPlan('plan4b')
    const game3 = located.find((l) => l.name.endsWith('Game_3.slpz'))!
    storage.state.corruptAt = game3.offset + 100 // always wrong
    const res = await run(plan2, library2)
    expect(res.failed).toEqual([id(4)])
    expect(res.files).toHaveLength(WANTED)
    expect(
      fs.existsSync(path.join(library2.folder, libraryRelativePath(id(4)))),
    ).toBe(false)
  })

  it('waits out a failing server, and stops cleanly when the zip was rebuilt', async () => {
    const library = fakeLibrary(path.join(dir, 'lib5'))
    storage.state.failNext = 3
    const ok = await run(newPlan('plan5'), library)
    expect(ok.files).toHaveLength(WANTED + 1)

    storage.state.etag = 'rebuilt-1'
    await expect(
      run(newPlan('plan5b'), fakeLibrary(path.join(dir, 'lib5b'))),
    ).rejects.toBeInstanceOf(SnapshotChangedError)
  })

  it('checks the local header and the CRC of every entry', () => {
    const g = located.find((l) => l.name.endsWith('Game_0.slpz'))!
    const entry: PlanEntry = {
      id: id(1),
      hash: '',
      zip: 0,
      header: g.header,
      offset: g.offset,
      length: g.length,
    }
    expect(sliceEntry(zip, 0, entry).equals(slpz)).toBe(true)
    const bad = Buffer.from(zip)
    bad[g.offset + 10] ^= 1
    expect(() => sliceEntry(bad, 0, entry)).toThrow(CorruptEntryError)
    expect(() =>
      sliceEntry(zip, 0, { ...entry, header: g.header + 1 }),
    ).toThrow(CorruptEntryError)
    expect(crc32(slpz)).toBe((zlib as any).crc32(slpz) >>> 0)
  })

  it('builds a plan page by page and resumes the listing where it stopped', async () => {
    const plan = DirectPlan.open(path.join(dir, 'plan6'))
    const pages: LocationsPage[] = [
      {
        snapshots: [SNAP],
        games: [[id(1), 'b'.repeat(32), 'G1.slp', 0, 100, 10, 50]],
        other: [id(7)],
        next: 'c1',
      },
      {
        snapshots: [SNAP],
        games: [[id(2), 'nohash', 'G2.slp', 0, 300, 10, 250]],
        other: [],
        next: 'c2',
      },
      { snapshots: [SNAP], games: [], other: [id(8)], next: null },
    ]
    const bodies: Record<string, unknown>[] = []
    let calls = 0
    const fetchPage = async (body: Record<string, unknown>) => {
      bodies.push(body)
      if (++calls === 2) throw new DatabaseRequestError('down', 503)
      return pages[Number(body.cursor?.toString().slice(1) ?? 0)]
    }
    await expect(
      buildPlan(
        plan,
        { filter: { p1CharacterId: '2', maxFiles: 3 } },
        fetchPage,
        new AbortController().signal,
      ),
    ).rejects.toThrow('down')
    const again = DirectPlan.open(path.join(dir, 'plan6'))
    expect(again.meta).toMatchObject({
      count: 1,
      other: 1,
      cursor: 'c1',
      complete: false,
    })
    await buildPlan(
      again,
      { filter: { p1CharacterId: '2', maxFiles: 3 } },
      fetchPage,
      new AbortController().signal,
    )
    expect(bodies.map((b) => b.cursor)).toEqual([undefined, 'c1', 'c1', 'c2'])
    expect(again.meta).toMatchObject({
      count: 2,
      other: 2,
      complete: true,
      bytes: 20,
    })
    expect(again.others()).toEqual([id(7), id(8)])
    expect(DirectPlan.open(path.join(dir, 'plan6')).entries().length).toBe(
      2 * 48,
    )

    // Id lists go 5,000 at a time.
    const idPlan = DirectPlan.open(path.join(dir, 'plan7'))
    const sent: number[] = []
    const ids = Array.from({ length: 12_000 }, (_, k) => id(k + 1))
    await buildPlan(
      idPlan,
      { replayIds: ids },
      async (body) => {
        sent.push((body.replayIds as string[]).length)
        expect(body.includeCpu).toBe(true)
        return {
          snapshots: [SNAP],
          games: [],
          other: body.replayIds as string[],
          next: null,
        }
      },
      new AbortController().signal,
    )
    expect(sent).toEqual([5000, 5000, 2000])
    expect(idPlan.meta).toMatchObject({ other: 12_000, complete: true })
  })

  describe('in the transfer manager', () => {
    function makeManager(
      responses: Record<
        string,
        (_body: any, _headers?: Record<string, string>) => unknown
      >,
      libFolder: string,
      replay?: (_id: string) => Buffer,
      plansUrl: string | null = null,
    ) {
      const library = fakeLibrary(libFolder)
      const imported: string[][] = []
      const manager = new TransferManager(
        { isDestroyed: () => false, webContents: { send: () => {} } } as never,
        {
          configDir: path.join(libFolder, 'config'),
          directMaxGames: 2,
          direct: {
            concurrency: 4,
            allowUrl: () => true,
            backoffMs: () => 5,
            plansUrl,
          },
          getArchive: () =>
            ({ path: path.join(dir, 'p.lcp'), name: 'P' }) as never,
          ensureProject: async () => undefined,
          getSlpzBinary: () => SLPZ,
          getLibrary: () => library,
          importer: {
            importInProgress: false,
            importPrepared: jest.fn(async (paths: string[]) => {
              imported.push(paths)
              return { inserted: paths.length, failed: 0 }
            }),
          } as never,
        },
      )
      const calls: {
        action: string
        body: any
        headers?: Record<string, string>
      }[] = []
      ;(manager as any).client = {
        replay: jest.fn(async (rid: string) => {
          calls.push({ action: 'replay', body: rid })
          if (!replay) throw new Error('no replay stub')
          return replay(rid)
        }),
        json: jest.fn(
          async (
            route: string,
            body?: unknown,
            _t?: string,
            _s?: AbortSignal,
            headers?: Record<string, string>,
          ) => {
            const action = /action=([\w-]+)/.exec(route)?.[1] ?? route
            calls.push({ action, body, headers })
            const handler = responses[action]
            if (!handler) throw new Error(`unexpected ${action}`)
            const out = handler(body, headers)
            if (out instanceof Error) throw out
            return out
          },
        ),
      }
      return { manager, library, imported, calls }
    }

    async function send(manager: TransferManager, payload: unknown) {
      let replied: any
      await manager.handle(
        {
          reply: (_c: string, b: any) => {
            replied = b.payload
          },
        } as never,
        { requestId: 'r', payload },
      )
      return replied
    }

    async function settle(manager: TransferManager, stages: string[]) {
      for (let i = 0; i < 2000; i++) {
        const job = manager.list()[0]
        if (job && stages.includes(job.stage)) return job
        await new Promise((resolve) => {
          setTimeout(resolve, 10)
        })
      }
      throw new Error(`never reached ${stages.join('/')}`)
    }

    const link = () => ({
      downloadId: 'd'.repeat(24),
      token: 't'.repeat(32),
      ...linksWith('tok1'),
    })

    it('a Find replays download: stored games by range, all imported; games in no zip are left out, never fetched', async () => {
      const slp = (tag: string) =>
        Buffer.concat([
          Buffer.from('{U\x03raw[$U#l', 'latin1'),
          Buffer.from(tag),
        ])
      const progress: any[] = []
      const { manager, library, imported, calls } = makeManager(
        {
          'direct-locations': () => ({ ...page(), other: [id(500), id(501)] }),
          'direct-link': () => link(),
          'direct-progress': (b) => {
            progress.push(b)
            return { status: 'downloading' }
          },
        },
        path.join(dir, 'tm1'),
        slp,
      )
      await send(manager, {
        action: 'start',
        filters: {
          p1Characters: ['2'],
          p2Characters: [],
          p1Codes: [],
          p2Codes: [],
          p1Tags: [],
          p2Tags: [],
          stageFilters: [],
          startDate: '',
          endDate: '',
          sources: ['netplay', 'ranked', 'tournament'],
          tournaments: [],
          sort: 'replayNewest',
          maxFiles: 1000,
        },
      })
      const job = await settle(manager, ['completed', 'failed'])
      expect(job.error).toBeUndefined()
      expect(job.stage).toBe('completed')
      const loc = calls.find((c) => c.action === 'direct-locations')!
      expect(loc.body).toMatchObject({
        p1CharacterId: '2',
        maxFiles: 1000,
        sort: 'startAt:-1',
        limit: 5000,
        storedOnly: true,
      })
      expect(calls.find((c) => c.action === 'direct-link')!.body).toMatchObject(
        { games: WANTED + 1, filter: { p1CharacterId: '2', storedOnly: true } },
      )
      // Two games no zip holds (a database without storedOnly would list them):
      // left out, never one by one from the server and never in a bundle.
      expect(calls.some((c) => c.action === 'replay')).toBe(false)
      expect(calls.some((c) => c.action === 'create')).toBe(false)
      expect(library.rows.size).toBe(WANTED + 1)
      expect(imported.at(-1)).toHaveLength(WANTED + 1)
      expect(job.detail).toMatch(
        /· 2 not available yet \(newer than the stored games\)$/,
      )
      expect(progress.at(-1)).toMatchObject({
        downloadId: 'd'.repeat(24),
        gamesDone: WANTED + 1,
        done: true,
        requests: 2,
      })
      // The plan's record files are gone; the transfer's folder holds no partial download.
      expect(
        fs.existsSync(path.join(job.outputDir, 'direct', 'plan.bin')),
      ).toBe(false)
      manager.cleanup()
    }, 30000)

    it('a matching prebuilt plan replaces the full-DB listing; only the rest is listed', async () => {
      const full = page()
      const planFile = zlib.brotliCompressSync(
        encodePlanFile(
          {
            snapshots: [SNAP],
            filter: { p1CharacterId: '2' },
            builtAt: 'test',
          },
          full.games.map(([gid, h, , z, offset, length, header]) => ({
            id: gid,
            hash: h,
            zip: z,
            offset,
            length,
            header,
          })),
        ),
      )
      const manifest = {
        v: 1,
        snapshot: SNAP.id,
        builtAt: 'test',
        plans: [
          {
            filter: { p1CharacterId: '2' },
            file: 'char/fox.ldp.br',
            sha256: sha(planFile),
            size: planFile.length,
            encoding: 'br',
            games: full.games.length,
            selected: full.games.length + 1,
            bytes: full.games.reduce((s, g) => s + g[5], 0),
          },
        ],
      }
      const served: string[] = []
      const plans = http.createServer((req, res) => {
        served.push(req.url!)
        if (req.url === '/v1/manifest.json') res.end(JSON.stringify(manifest))
        else if (req.url === '/v1/char/fox.ldp.br') res.end(planFile)
        else res.writeHead(404).end()
      })
      await new Promise<void>((resolve) => {
        plans.listen(0, '127.0.0.1', () => resolve())
      })
      const plansUrl = `http://127.0.0.1:${(plans.address() as { port: number }).port}/v1/manifest.json`
      _resetManifestCache()
      // An older database ignores exceptSnapshot and sends everything: those rows
      // are dropped, the plan comes out the same.
      const { manager, library, calls } = makeManager(
        {
          'direct-locations': () => ({ ...page(), other: [id(500)] }),
          'direct-link': () => link(),
          'direct-progress': () => ({ status: 'downloading' }),
        },
        path.join(dir, 'tm-prebuilt'),
        () =>
          Buffer.concat([
            Buffer.from('{U\x03raw[$U#l', 'latin1'),
            Buffer.from('newer'),
          ]),
        plansUrl,
      )
      await send(manager, {
        action: 'start',
        filters: {
          p1Characters: ['2'],
          p2Characters: [],
          p1Codes: [],
          p2Codes: [],
          p1Tags: [],
          p2Tags: [],
          stageFilters: [],
          startDate: '',
          endDate: '',
          sources: ['netplay', 'ranked', 'tournament'],
          tournaments: [],
          sort: 'replayNewest',
          maxFiles: full.games.length + 1,
        },
      })
      const job = await settle(manager, ['completed', 'failed'])
      plans.close()
      expect(job.error).toBeUndefined()
      expect(served).toEqual(['/v1/manifest.json', '/v1/char/fox.ldp.br'])
      const loc = calls.filter((c) => c.action === 'direct-locations')
      expect(loc).toHaveLength(1)
      expect(loc[0].body).toMatchObject({
        p1CharacterId: '2',
        exceptSnapshot: SNAP.id,
        storedOnly: true,
      })
      expect(loc[0].body.maxFiles).toBeUndefined()
      expect(calls.find((c) => c.action === 'direct-link')!.body).toMatchObject(
        { games: full.games.length },
      )
      // The one game in no zip is left out (never fetched from the server).
      expect(library.rows.size).toBe(full.games.length)
      expect(calls.some((c) => c.action === 'replay')).toBe(false)
      manager.cleanup()
    }, 30000)

    it("Find replays' estimate is the stored games' count and bytes, in one query", async () => {
      const filters = {
        p1Characters: ['2'],
        p2Characters: [],
        p1Codes: [],
        p2Codes: [],
        p1Tags: [],
        p2Tags: [],
        stageFilters: [],
        startDate: '',
        endDate: '',
        sources: ['netplay', 'ranked', 'tournament'],
        tournaments: [],
        sort: 'replayNewest',
        maxFiles: 1000,
      }
      const estimate = {
        replayCount: 1000,
        rawSize: 3e9,
        estimatedSlpzSize: 4e8,
      }
      const { manager, calls } = makeManager(
        {
          estimate: () => estimate,
          'direct-locations': () => ({
            located: 1000,
            locatedBytes: 4e8,
            other: 0,
          }),
        },
        path.join(dir, 'tm-estimate'),
      )
      const reply = await send(manager, { action: 'estimate', filters })
      expect(reply.estimate).toEqual({
        replayCount: 1000,
        rawSize: 4e8,
        estimatedSlpzSize: 4e8,
        estimatedZipSize: 4e8,
        direct: { located: 1000, locatedBytes: 4e8, other: 0 },
      })
      expect(calls.map((c) => c.action)).toEqual(['direct-locations'])
      expect(calls[0].body).toMatchObject({
        p1CharacterId: '2',
        maxFiles: 1000,
        count: true,
        storedOnly: true,
      })
      // An older website without the count: the database's estimate of the same
      // stored-only selection.
      const old = makeManager(
        {
          estimate: () => estimate,
          'direct-locations': () =>
            new DatabaseRequestError('Invalid action or method.', 400),
        },
        path.join(dir, 'tm-estimate2'),
      )
      const oldReply = await send(old.manager, { action: 'estimate', filters })
      expect(oldReply.estimate).toMatchObject({ replayCount: 1000 })
      expect(oldReply.estimate.direct).toBeUndefined()
      expect(
        old.calls.find((c) => c.action === 'estimate')!.body,
      ).toMatchObject({
        storedOnly: true,
      })
      // Rate limited: the panel waits and asks again (not a silent fallback).
      const busy = makeManager(
        {
          'direct-locations': () =>
            new DatabaseRequestError('Too many', 429, 'rate_limited', 7),
        },
        path.join(dir, 'tm-estimate3'),
      )
      expect(
        await send(busy.manager, { action: 'estimate', filters }),
      ).toMatchObject({ retryAfter: 7 })
      manager.cleanup()
      old.manager.cleanup()
      busy.manager.cleanup()
    })

    it('Find replays never falls back to the server: no direct downloads, or a refused link, stops the transfer', async () => {
      for (const { refusal, stage, detail } of [
        {
          refusal: {
            'direct-locations': () =>
              new DatabaseRequestError('Invalid action or method.', 400),
          },
          stage: 'failed',
          detail: /needs attention/,
        },
        {
          refusal: {
            'direct-locations': () => page(),
            'direct-link': () =>
              new DatabaseRequestError(
                'Direct download limit reached (30 downloads per 24h).',
                429,
                'direct_rate_limited',
                3600,
              ),
          },
          stage: 'paused',
          detail: /Direct download limit reached.*Resume to try again/,
        },
      ]) {
        const { manager, calls } = makeManager(
          {
            ...refusal,
            create: () =>
              new DatabaseRequestError('stop here', 400, 'filter_required'),
          } as never,
          path.join(dir, `tm-fallback-${Object.keys(refusal).length}`),
        )
        await send(manager, {
          action: 'start',
          filters: {
            p1Characters: ['2'],
            p2Characters: [],
            p1Codes: [],
            p2Codes: [],
            p1Tags: [],
            p2Tags: [],
            stageFilters: [],
            startDate: '',
            endDate: '',
            sources: ['netplay', 'ranked', 'tournament'],
            tournaments: [],
            sort: 'replayNewest',
            maxFiles: 1000,
          },
        })
        const job = await settle(manager, ['failed', 'completed', 'paused'])
        // Stopped (a limit: paused, Resume later), never a bundle or the server.
        expect(job.stage).toBe(stage)
        expect(job.detail).toMatch(detail)
        expect(calls.some((c) => c.action === 'create')).toBe(false)
        expect(calls.some((c) => c.action === 'replay')).toBe(false)
        manager.cleanup()
      }
    }, 30000)

    it("a list that isn't from Find replays (Download again) still falls back to the old paths", async () => {
      const { manager, calls } = makeManager(
        {
          'direct-locations': () =>
            new DatabaseRequestError('Invalid action or method.', 400),
          create: () =>
            new DatabaseRequestError('stop here', 400, 'filter_required'),
        },
        path.join(dir, 'tm-fallback-list'),
      )
      manager.downloadReplays([id(1), id(2), id(3)], 'Three missing replays')
      await settle(manager, ['failed', 'completed'])
      expect(calls.find((c) => c.action === 'create')?.body).toMatchObject({
        replayIds: [id(1), id(2), id(3)],
      })
      manager.cleanup()
    }, 30000)
  })
})
