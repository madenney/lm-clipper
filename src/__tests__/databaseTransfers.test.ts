/** @jest-environment node */
import fs from 'fs'
import os from 'os'
import path from 'path'
import zlib from 'zlib'
import { execFileSync } from 'child_process'
import {
  BUNDLE_MANIFEST_NAME,
  defaultDatabaseFilters,
  parseDatabaseEstimate,
  parseDatabaseRequest,
  validateDatabaseFilters,
} from '../constants/database'
import { defaultClipSearch } from '../constants/clipSearch'
import {
  DatabaseRequestError,
  ReplayTooLargeError,
} from '../main/databaseClient'
import {
  LibraryAccess,
  extractBundleIntoLibrary,
  readBundleManifest,
} from '../main/replayExtraction'
import { libraryRelativePath } from '../main/replayLibrary'

// The integration tests below serve the bundle from memory instead of HTTP.
const mockDownloads: { zip?: Buffer; calls: string[] } = { calls: [] }
jest.mock('../main/databaseClient', () => {
  const actual = jest.requireActual('../main/databaseClient')
  return {
    ...actual,
    downloadBundle: jest.fn(async (url: string, destination: string) => {
      mockDownloads.calls.push(url)
      // eslint-disable-next-line global-require
      require('fs').writeFileSync(destination, mockDownloads.zip)
    }),
  }
})

jest.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => os.tmpdir() },
  dialog: {},
  shell: {},
}))

// eslint-disable-next-line import/first
import TransferManager, {
  ExportGoneError,
  MaintenanceError,
  RetryLaterError,
  maintenanceDetail,
  classifyRemoteError,
  importSummary,
  interpretStatus,
  describeRemoteStatus,
  formatWait,
  isInside,
  isNetworkError,
  parseSavedTransfer,
  readyAtOf,
  realPath,
  recoverTransfer,
  removeUnfinishedAttempts,
} from '../main/managers/TransferManager'

// Stored (uncompressed) ZIP with several entries and real CRCs.
function buildZip(entries: { name: string; data: string | Buffer }[]): Buffer {
  const crc32 = (zlib as unknown as { crc32: (_b: Buffer) => number }).crc32
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name)
    const data = Buffer.from(entry.data)
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50)
    central.writeUInt16LE(0x0314, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE((0x81a4 << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    locals.push(local, name, data)
    centrals.push(central, name)
    offset += local.length + name.length + data.length
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, ...centrals, end])
}

/** A stable 24-hex replay id per test hash (h1 -> ...6831). */
const rid = (fileHash: string) =>
  Buffer.from(fileHash).toString('hex').padStart(24, '0').slice(-24)

/** A replay's bytes as the website sends them (starts like a .slp). */
const slpOf = (tag: string) =>
  Buffer.concat([Buffer.from('{U\x03raw[$U#l', 'latin1'), Buffer.from(tag)])
const manifest = (
  replays: { file: string; fileHash: string; replayId?: string }[],
) =>
  JSON.stringify({
    version: 1,
    replays: replays.map((r) => ({ replayId: rid(r.fileHash), ...r })),
  })

/** In-memory stand-in for library.sqlite with the same lookup rules. */
function fakeLibrary(folder: string) {
  const rows = new Map<string, { fileHash: string; path: string }>()
  const lib: LibraryAccess & { rows: typeof rows } = {
    folder,
    rows,
    lookup: async (replayIds, fileHashes) => {
      const have: Record<string, string> = {}
      const haveHashes: Record<string, string> = {}
      for (const id of replayIds) {
        const row = rows.get(id)
        if (row && fs.existsSync(row.path)) have[id] = row.path
      }
      for (const row of rows.values())
        if (fileHashes.includes(row.fileHash) && fs.existsSync(row.path))
          haveHashes[row.fileHash] ??= row.path
      return {
        have,
        haveHashes,
        missing: replayIds.filter((id) => !have[id]),
      }
    },
    register: async (entries) => {
      for (const e of entries)
        rows.set(e.replayId, { fileHash: e.fileHash, path: e.path })
    },
  }
  return lib
}

describe('filter normalisation', () => {
  it('trims, drops empty and repeated values', () => {
    const filters = validateDatabaseFilters({
      ...defaultDatabaseFilters,
      p1Codes: [' MANG#0', 'ZAIN#0 ', '', ' ', 'MANG#0'],
    })
    expect(filters.p1Codes).toEqual(['MANG#0', 'ZAIN#0'])
  })

  it('rejects more values than the website accepts', () => {
    const many = Array.from({ length: 21 }, (_, i) => `A#${i}`)
    expect(() =>
      validateDatabaseFilters({ ...defaultDatabaseFilters, p1Codes: many }),
    ).toThrow(/at most 20/)
  })
})

describe('export status', () => {
  it('waits on every active database status', () => {
    for (const status of [
      'pending',
      'processing',
      'bundling',
      'bundled',
      'uploading',
    ])
      expect(interpretStatus({ status })).toBe('wait')
  })

  it('downloads a completed export only while its bundle exists', () => {
    expect(interpretStatus({ status: 'completed', downloadReady: true })).toBe(
      'ready',
    )
    expect(() =>
      interpretStatus({ status: 'completed', downloadReady: false }),
    ).toThrow(ExportGoneError)
  })

  it('treats failed and cancelled exports as gone', () => {
    expect(() => interpretStatus({ status: 'failed' })).toThrow(ExportGoneError)
    expect(() => interpretStatus({ status: 'cancelled' })).toThrow(
      ExportGoneError,
    )
  })

  it('rejects statuses the database never sends', () => {
    expect(() => interpretStatus({ status: 'expired' })).toThrow(/Unexpected/)
  })
})

describe('server queue wording', () => {
  it('formats waits like the website', () => {
    expect(formatWait(20)).toBe('under a minute')
    expect(formatWait(35 * 60)).toBe('about 35 min')
    expect(formatWait(2 * 3600 + 10 * 60)).toBe('about 2 h 10 min')
    expect(formatWait(3 * 86400)).toBe('about 3 days')
  })

  it('says where a waiting export is and when it should be ready', () => {
    expect(
      describeRemoteStatus({
        status: 'pending',
        queuePosition: 3,
        estimatedWaitSec: 240,
        estimatedProcessingTimeSec: 300,
      }),
    ).toBe('#3 in the server queue · ready in about 9 min')
    expect(describeRemoteStatus({ status: 'pending' })).toBe(
      'In the server queue',
    )
    expect(
      describeRemoteStatus({
        status: 'processing',
        queuePosition: 0,
        estimatedProcessingTimeSec: 90,
        sharedWith: 2,
      }),
    ).toBe(
      'The server is gathering your replays · ready in about 2 min · shared with 2 others',
    )
    expect(describeRemoteStatus({ status: 'uploading' })).toBe(
      'The server is uploading your bundle',
    )
    expect(
      describeRemoteStatus({
        status: 'pending',
        paused: 'Downloads are paused for maintenance.',
      }),
    ).toBe('Server downloads are paused. Downloads are paused for maintenance.')
  })
})

describe('remote error classification', () => {
  it('needs a new export when the bundle or grant is gone', () => {
    for (const code of [
      'bundle_missing',
      'not_found',
      'forbidden',
      'grant_invalid',
    ])
      expect(
        classifyRemoteError(new DatabaseRequestError('x', 410, code)),
      ).toBeInstanceOf(ExportGoneError)
  })

  it('retries the same export after caps and rate limits', () => {
    for (const code of ['download_cap', 'storage_busy', 'rate_limited'])
      expect(
        classifyRemoteError(new DatabaseRequestError('x', 503, code)),
      ).toBeInstanceOf(RetryLaterError)
    expect(
      classifyRemoteError(new DatabaseRequestError('x', 429)),
    ).toBeInstanceOf(RetryLaterError)
  })

  it('names a lost connection instead of an empty message', () => {
    const agg = new AggregateError(
      [
        Object.assign(new Error('a'), { code: 'ECONNREFUSED' }),
        Object.assign(new Error('b'), { code: 'ENOTFOUND' }),
      ],
      '',
    )
    expect(isNetworkError(agg)).toBe(true)
    expect(classifyRemoteError(agg).message).toBe(
      "Can't reach lunarmelee.com (ECONNREFUSED, ENOTFOUND). Check your internet connection, then Resume: games already downloaded are kept.",
    )
    expect(
      isNetworkError(new Error('Connection timed out. Please retry.')),
    ).toBe(true)
    expect(isNetworkError(new DatabaseRequestError('x', 502))).toBe(false)
    expect(
      isNetworkError(new Error('The download was not a replay file.')),
    ).toBe(false)
  })

  it('leaves other failures alone', () => {
    const error = new DatabaseRequestError('x', 400, 'unknown')
    expect(classifyRemoteError(error)).toBe(error)
  })

  it('waits out maintenance instead of retrying or failing', () => {
    const e = classifyRemoteError(
      new DatabaseRequestError('Moving servers', 503, 'maintenance'),
    )
    expect(e).toBeInstanceOf(MaintenanceError)
    expect(e.message).toBe('Moving servers')
    expect(maintenanceDetail('Moving servers.')).toBe(
      "Lunar Database: Moving servers. Resumes by itself when it's back.",
    )
  })
})

describe('import summary', () => {
  it('explains why fewer replays were added than the batch held', () => {
    expect(
      importSummary({ inserted: 90, failed: 0, skipped: 7, duplicates: 3 }),
    ).toBe(
      '90 replays added · 3 already in project · 7 skipped (not 1v1 singles or under 20 seconds)',
    )
  })
})

describe('database bundle extraction into the library', () => {
  let root: string
  let library: ReturnType<typeof fakeLibrary>
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'lunar-bundles-'))
    library = fakeLibrary(path.join(root, 'Library'))
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  function writeBundle(
    name: string,
    replays: { file: string; fileHash: string; replayId?: string }[],
    data = (r: { fileHash: string }): string | Buffer => `replay ${r.fileHash}`,
  ) {
    const zip = path.join(root, name)
    fs.writeFileSync(
      zip,
      buildZip([
        ...replays.map((r) => ({ name: r.file, data: data(r) })),
        { name: BUNDLE_MANIFEST_NAME, data: manifest(replays) },
      ]),
    )
    return zip
  }
  const libPath = (hash: string) =>
    path.join(library.folder, libraryRelativePath(rid(hash)))

  it('reads the manifest', async () => {
    const zip = writeBundle('a.zip', [{ file: '0_a.slp', fileHash: 'h1' }])
    expect(await readBundleManifest(zip)).toEqual([
      { file: '0_a.slp', fileHash: 'h1', replayId: rid('h1') },
    ])
  })

  it('puts each replay at its library path and registers it', async () => {
    const zip = writeBundle('a.zip', [
      { file: '0_a.slp', fileHash: 'h1' },
      { file: '1_b.slp', fileHash: 'h2' },
    ])
    const result = await extractBundleIntoLibrary(zip, library, 'slpz')
    expect(result).toEqual({
      files: [libPath('h1'), libPath('h2')],
      extracted: 2,
      reused: 0,
    })
    expect(fs.readFileSync(libPath('h2'), 'utf8')).toBe('replay h2')
    expect(library.rows.get(rid('h1'))).toEqual({
      fileHash: 'h1',
      path: libPath('h1'),
    })
    expect(fs.existsSync(zip)).toBe(true)
  })

  it('keeps .slpz entries compressed when the library keeps downloads compressed', async () => {
    const zip = writeBundle('z.zip', [
      { file: '0_a.slpz', fileHash: 'h1' },
      { file: '1_b.slp', fileHash: 'h2' },
    ])
    const compressed = { ...library, compress: true }
    // No decoder needed: the .slpz bytes are stored as they came.
    const result = await extractBundleIntoLibrary(zip, compressed, '/no/slpz')
    const z = path.join(library.folder, libraryRelativePath(rid('h1'), '.slpz'))
    expect(result?.files).toEqual([z, libPath('h2')])
    expect(fs.readFileSync(z, 'utf8')).toBe('replay h1')
    expect(fs.readFileSync(libPath('h2'), 'utf8')).toBe('replay h2')
    // Again: both are had, in their stored forms.
    const again = await extractBundleIntoLibrary(
      writeBundle('z2.zip', [
        { file: '0_a.slpz', fileHash: 'h9', replayId: rid('h1') },
      ]),
      {
        ...compressed,
        lookup: async () => ({ have: {}, haveHashes: {}, missing: [] }),
      },
      '/no/slpz',
    )
    expect(again).toEqual({ files: [z], extracted: 0, reused: 0 })
  })

  it('downloads a game once: overlapping batches reuse library files', async () => {
    await extractBundleIntoLibrary(
      writeBundle('first.zip', [
        { file: '0_a.slp', fileHash: 'h1' },
        { file: '1_b.slp', fileHash: 'h2' },
      ]),
      library,
      'slpz',
    )
    const before = fs.statSync(libPath('h2')).mtimeMs
    const second = await extractBundleIntoLibrary(
      writeBundle('second.zip', [
        { file: '0_b.slp', fileHash: 'h2' },
        { file: '1_c.slp', fileHash: 'h3' },
      ]),
      library,
      'slpz',
    )
    expect(second).toEqual({
      files: [libPath('h2'), libPath('h3')],
      extracted: 1,
      reused: 1,
    })
    expect(fs.statSync(libPath('h2')).mtimeMs).toBe(before)
  })

  it('reuses the same recording stored under another replay id', async () => {
    await extractBundleIntoLibrary(
      writeBundle('a.zip', [{ file: '0_a.slp', fileHash: 'h1' }]),
      library,
      'slpz',
    )
    const other = 'f'.repeat(24)
    const result = await extractBundleIntoLibrary(
      writeBundle('b.zip', [
        { file: '0_a.slp', fileHash: 'h1', replayId: other },
      ]),
      library,
      'slpz',
    )
    expect(result).toEqual({ files: [libPath('h1')], extracted: 0, reused: 1 })
    expect(library.rows.get(other)?.path).toBe(libPath('h1'))
  })

  it('re-extracts a replay whose library file was deleted', async () => {
    const bundle = writeBundle('a.zip', [{ file: '0_a.slp', fileHash: 'h1' }])
    await extractBundleIntoLibrary(bundle, library, 'slpz')
    fs.rmSync(libPath('h1'))
    const again = await extractBundleIntoLibrary(bundle, library, 'slpz')
    expect(again?.extracted).toBe(1)
    expect(fs.existsSync(libPath('h1'))).toBe(true)
  })

  it('finishes an interrupted run: complete files are kept, partial ones redone', async () => {
    const bundle = writeBundle('a.zip', [
      { file: '0_a.slp', fileHash: 'h1' },
      { file: '1_b.slp', fileHash: 'h2' },
    ])
    // h1 finished before the interruption but was never registered; h2 was
    // cut off mid-write.
    fs.mkdirSync(path.dirname(libPath('h1')), { recursive: true })
    fs.writeFileSync(libPath('h1'), 'replay h1')
    fs.mkdirSync(path.dirname(libPath('h2')), { recursive: true })
    fs.writeFileSync(`${libPath('h2')}.part`, 'rep')
    const result = await extractBundleIntoLibrary(bundle, library, 'slpz')
    expect(result?.files).toEqual([libPath('h1'), libPath('h2')])
    expect(result?.extracted).toBe(1)
    expect(fs.readFileSync(libPath('h2'), 'utf8')).toBe('replay h2')
    expect(fs.existsSync(`${libPath('h2')}.part`)).toBe(false)
    expect(library.rows.size).toBe(2)
  })

  it('returns null for bundles without a usable manifest', async () => {
    const zip = path.join(root, 'old.zip')
    fs.writeFileSync(zip, buildZip([{ name: '0_a.slp', data: 'x' }]))
    expect(await extractBundleIntoLibrary(zip, library, 'slpz')).toBeNull()
    const badIds = path.join(root, 'bad.zip')
    fs.writeFileSync(
      badIds,
      buildZip([
        { name: '0_a.slp', data: 'x' },
        {
          name: BUNDLE_MANIFEST_NAME,
          data: manifest([
            { file: '0_a.slp', fileHash: 'h1', replayId: '../../etc' },
          ]),
        },
      ]),
    )
    expect(await extractBundleIntoLibrary(badIds, library, 'slpz')).toBeNull()
    expect(fs.existsSync(library.folder)).toBe(false)
  })

  const slpz = path.resolve(__dirname, '../../release/app/slpz/slpz-linux-x64')
  const realReplay = path.resolve(__dirname, '../../assets/test.slp')
  const binaries =
    process.platform === 'linux' &&
    fs.existsSync(slpz) &&
    fs.existsSync(realReplay)
      ? [slpz]
      : []
  // Without the slpz binary (npm run build:slpz) this is skipped, not failed.
  const itWithSlpz = binaries.length ? it : it.skip
  itWithSlpz(
    'decompresses SLPZ entries into the library',
    async () => {
      const compressed = path.join(root, 'game.slpz')
      execFileSync(slpz, ['-x', '-o', compressed, realReplay])
      const zip = writeBundle(
        'real.zip',
        [{ file: '0_game.slpz', fileHash: 'real' }],
        () => fs.readFileSync(compressed),
      )
      const result = await extractBundleIntoLibrary(zip, library, slpz)
      expect(result?.files).toEqual([libPath('real')])
      expect(
        fs.readFileSync(libPath('real')).equals(fs.readFileSync(realReplay)),
      ).toBe(true)
      expect(fs.readdirSync(path.dirname(libPath('real')))).toEqual([
        `${rid('real')}.slp`,
      ])
    },
    30000,
  )
})

describe('IPC request parsing', () => {
  it('accepts well-formed requests and normalises filters', () => {
    const request = parseDatabaseRequest({
      action: 'search',
      filters: { ...defaultDatabaseFilters, p1Codes: [' A#1 '] },
      page: 2,
    })
    expect(request).toMatchObject({ action: 'search', page: 2 })
    expect(request.action === 'search' && request.filters.p1Codes).toEqual([
      'A#1',
    ])
    expect(parseDatabaseRequest({ action: 'clearFinished' })).toEqual({
      action: 'clearFinished',
    })
    expect(parseDatabaseRequest({ action: 'library' })).toEqual({
      action: 'library',
    })
  })

  it('rejects unknown actions and wrongly typed fields', () => {
    expect(() => parseDatabaseRequest({ action: 'delete' })).toThrow()
    expect(() =>
      parseDatabaseRequest({ action: 'remove', id: '../../etc' }),
    ).toThrow()
    expect(() => parseDatabaseRequest(null)).toThrow()
    expect(() =>
      parseDatabaseRequest({ action: 'open', id: '../../etc' }),
    ).toThrow()
    expect(() =>
      parseDatabaseRequest({
        action: 'extract',
        outputDir: '/tmp',
        sourceKind: 'everything',
      }),
    ).toThrow()
    expect(() =>
      parseDatabaseRequest({ action: 'start', filters: {}, outputDir: '' }),
    ).toThrow()
  })
})

describe('saved transfer validation', () => {
  const valid = {
    id: '6f1c2c1e-1111-4222-8333-944455556666',
    kind: 'database',
    title: 'Up to 10 Lunar replays',
    detail: 'Waiting',
    stage: 'paused',
    createdAt: 1,
    current: 0,
    total: null,
    outputDir: '/home/u/Replays/Lunar-2026',
    filters: defaultDatabaseFilters,
    remoteId: 'a'.repeat(24),
  }

  it('accepts a well-formed record', () => {
    expect(parseSavedTransfer(valid).id).toBe(valid.id)
  })

  it('rejects records that would point work somewhere unexpected', () => {
    for (const bad of [
      { ...valid, outputDir: 'relative/dir' },
      { ...valid, preparedPath: '/elsewhere/replays' },
      { ...valid, sources: ['relative.zip'] },
      { ...valid, stage: 'exploded' },
      { ...valid, remoteId: 'not-an-id' },
      { ...valid, filters: undefined },
    ])
      expect(() => parseSavedTransfer(bad)).toThrow(/Invalid saved transfer/)
  })

  it('keeps the waiting-for-maintenance mark, and only as a boolean', () => {
    expect(
      parseSavedTransfer({ ...valid, waitingForDatabase: true })
        .waitingForDatabase,
    ).toBe(true)
    expect(() =>
      parseSavedTransfer({ ...valid, waitingForDatabase: 'yes' }),
    ).toThrow(/Invalid saved transfer/)
  })

  it('allows a prepared folder inside the transfer folder', () => {
    expect(
      parseSavedTransfer({
        ...valid,
        preparedPath: '/home/u/Replays/Lunar-2026/replays-1',
      }).preparedPath,
    ).toBe('/home/u/Replays/Lunar-2026/replays-1')
  })
})

describe('real-path containment', () => {
  let root: string
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'lunar-paths-'))
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it('sees through a symlinked destination into the source folder', () => {
    const source = path.join(root, 'source')
    fs.mkdirSync(source)
    fs.symlinkSync(source, path.join(root, 'alias'))
    const destination = path.join(root, 'alias', 'new-output')
    expect(isInside(path.resolve(destination), source)).toBe(false)
    expect(isInside(realPath(destination), realPath(source))).toBe(true)
  })

  it('keeps unrelated folders apart', () => {
    expect(
      isInside(
        realPath(path.join(root, 'out')),
        realPath(path.join(root, 'in')),
      ),
    ).toBe(false)
  })
})

describe('estimate validation', () => {
  it('accepts numbers and drops a malformed optional field', () => {
    expect(
      parseDatabaseEstimate({
        replayCount: 10,
        rawSize: 800,
        estimatedSlpzSize: 100,
        estimatedZipSize: 'big',
      }),
    ).toEqual({ replayCount: 10, rawSize: 800, estimatedSlpzSize: 100 })
  })

  it('rejects missing or non-numeric required fields', () => {
    expect(() => parseDatabaseEstimate({ replayCount: '10' })).toThrow(
      /invalid estimate/,
    )
    expect(() => parseDatabaseEstimate(null)).toThrow(/invalid estimate/)
  })
})

describe('unfinished extraction attempts', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lunar-attempts-'))
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('removes stale attempts but keeps the completed one and other files', async () => {
    for (const name of ['replays-aaaaaaaa', 'replays-bbbbbbbb', 'notes'])
      fs.mkdirSync(path.join(dir, name))
    fs.writeFileSync(path.join(dir, 'download.zip'), 'zip')
    const keep = path.join(dir, 'replays-bbbbbbbb')

    const removed = await removeUnfinishedAttempts(dir, keep)

    expect(removed).toEqual([path.join(dir, 'replays-aaaaaaaa')])
    expect(fs.readdirSync(dir).sort()).toEqual([
      'download.zip',
      'notes',
      'replays-bbbbbbbb',
    ])
  })
})

describe('transfer manager end to end', () => {
  let dir: string
  let project: { path: string; name: string } | null
  let library: ReturnType<typeof fakeLibrary>
  const imported: string[][] = []
  const importer = {
    importInProgress: false,
    importPrepared: jest.fn(async (paths: string[]) => {
      imported.push(paths)
      return { inserted: 2, failed: 0, skipped: 1, duplicates: 0 }
    }),
  }

  const addedClips: { clips: unknown[]; paths: Record<string, string> }[] = []
  function makeManager(
    responses: Record<string, unknown[]>,
    onCompleted?: (_job: unknown) => void,
    {
      directMaxGames = 0,
      replay,
      maintenancePollMs,
    }: {
      directMaxGames?: number
      replay?: (_id: string) => Buffer | Error
      maintenancePollMs?: number
    } = {},
  ) {
    const manager = new TransferManager(
      { isDestroyed: () => false, webContents: { send: () => {} } } as never,
      {
        configDir: dir,
        // These tests cover the bundle path; the direct path has its own below
        // (and direct snapshot downloads theirs, in directDownload.test.ts).
        directMaxGames,
        direct: { enabled: false },
        getArchive: () => project as never,
        ensureProject: async () => undefined,
        getSlpzBinary: () => 'slpz',
        getLibrary: () => library,
        onCompleted,
        addClips: async (
          _p: string,
          clips: unknown[],
          paths: Record<string, string>,
        ) => {
          addedClips.push({ clips, paths })
          return { added: clips.length, unavailable: 0 }
        },
        importer: importer as never,
        maintenancePollMs,
      },
    )
    const requests: string[] = []
    const bodies: unknown[] = []
    const replayCalls: string[] = []
    const replayOpts: { storedOnly?: boolean }[] = []
    ;(manager as unknown as { client: unknown }).client = {
      replay: jest.fn(async (id: string, _signal?: unknown, opts = {}) => {
        replayCalls.push(id)
        replayOpts.push(opts)
        const r = replay?.(id) ?? new Error('no replay stub')
        if (r instanceof Error) throw r
        return r
      }),
      json: jest.fn(async (route: string, body?: unknown) => {
        requests.push(route)
        if (body !== undefined) bodies.push(body)
        const key = route.match(/action=([\w-]+)/)?.[1] ?? route
        const next = responses[key]?.shift()
        if (next === undefined) throw new Error(`no stub for ${route}`)
        if (next instanceof Error) throw next
        return next
      }),
    }
    return { manager, requests, bodies, replayCalls, replayOpts }
  }

  async function send(manager: TransferManager, payload: unknown) {
    let replied: any
    await manager.handle(
      {
        reply: (_c: string, body: any) => {
          replied = body.payload
        },
      } as never,
      { requestId: 'r1', payload },
    )
    return replied
  }

  async function settle(manager: TransferManager, stages: string[]) {
    // Status polls are 3 seconds apart, so allow a few of them.
    for (let i = 0; i < 1000; i++) {
      const job = manager.list()[0]
      if (job && stages.includes(job.stage)) return job
      await new Promise((resolve) => {
        setTimeout(resolve, 10)
      })
    }
    throw new Error(`transfer never reached ${stages.join('/')}`)
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lunar-manager-'))
    project = { path: path.join(dir, 'project.lcp'), name: 'Project' }
    library = fakeLibrary(path.join(dir, 'Library'))
    imported.length = 0
    mockDownloads.calls = []
    mockDownloads.zip = buildZip([
      { name: '0_a.slp', data: 'a' },
      { name: '1_b.slp', data: 'b' },
      {
        name: BUNDLE_MANIFEST_NAME,
        data: manifest([
          { file: '0_a.slp', fileHash: 'ha' },
          { file: '1_b.slp', fileHash: 'hb' },
        ]),
      },
    ])
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  const start = {
    action: 'start',
    filters: { ...defaultDatabaseFilters, maxFiles: 2 },
    outputDir: '',
  }

  it("Find replays never packs a bundle: a search it can't read from storage stops instead", async () => {
    const { manager, requests, bodies } = makeManager({
      // An older website without direct downloads, then a limit.
      'direct-locations': [
        new DatabaseRequestError('Not found', 404, 'not_found'),
        new DatabaseRequestError('Too many', 429, 'direct_rate_limited', 60),
      ],
      create: [{ jobId: 'a'.repeat(24), token: 't1' }],
    })
    const reply = await send(manager, {
      ...start,
      filters: { ...defaultDatabaseFilters, maxFiles: 500 },
      outputDir: path.join(dir, 'Replays'),
    })
    expect(reply.error).toBeUndefined()
    const job = await settle(manager, ['completed', 'failed', 'paused'])
    expect(job.stage).toBe('failed')
    expect(job.detail).toBe('Transfer needs attention.')
    // It asked where the stored games are, never for an export.
    expect(requests).toEqual(['/api/clipper?action=direct-locations'])
    expect(bodies[0]).toMatchObject({ storedOnly: true, maxFiles: 500 })
    await send(manager, { action: 'resume', id: job.id })
    const paused = await settle(manager, ['paused'])
    expect(paused.detail).toMatch(/Resume to try again/)
    expect(requests.some((r) => r.includes('action=create'))).toBe(false)
    expect(imported).toEqual([])
    manager.cleanup()
  }, 20000)

  it("a list that isn't from Find replays (Download again) still prepares, downloads and extracts a bundle", async () => {
    const { manager, requests } = makeManager({
      create: [{ jobId: 'a'.repeat(24), token: 't1' }],
      status: [
        { status: 'bundling' },
        { status: 'completed', downloadReady: true },
      ],
      file: [{ url: 'https://s3.us-east-005.backblazeb2.com/b/x.zip' }],
    })
    manager.downloadReplays([rid('ha'), rid('hb')], 'Two missing replays')
    const job = await settle(manager, ['completed', 'failed'])
    expect(job.stage).toBe('completed')
    expect(requests.map((r) => r.match(/action=(\w+)/)![1])).toEqual([
      'create',
      'status',
      'status',
      'file',
    ])
    // The batch went into the library; its ZIP is gone.
    expect(library.rows.size).toBe(2)
    expect(
      job.outputDir.startsWith(path.join(library.folder, 'Downloads')),
    ).toBe(true)
    expect(fs.existsSync(path.join(job.outputDir, 'download.zip'))).toBe(false)
    manager.cleanup()
  }, 20000)

  it('pauses for maintenance without losing the partial download, then resumes by itself', async () => {
    const down = new DatabaseRequestError('Moving servers', 503, 'maintenance')
    const { manager, requests } = makeManager(
      {
        create: [{ jobId: 'a'.repeat(24), token: 't1' }],
        // The database goes down while the export waits, then comes back.
        status: [
          { status: 'bundling' },
          down,
          { status: 'completed', downloadReady: true },
        ],
        file: [{ url: 'https://s3.us-east-005.backblazeb2.com/b/m.zip' }],
        '/api/status': [
          { database: 'down', maintenance: { message: 'Moving servers' } },
          { database: 'up', maintenance: null, notice: null, queue: null },
        ],
      },
      undefined,
      { maintenancePollMs: 20 },
    )
    manager.downloadReplays([rid('ha'), rid('hb')], 'Two missing replays')
    const paused = await settle(manager, ['paused', 'failed', 'completed'])
    expect(paused).toMatchObject({ stage: 'paused', waitingForDatabase: true })
    expect(paused.error).toBeUndefined()
    expect(paused.detail).toBe(
      "Lunar Database: Moving servers. Resumes by itself when it's back.",
    )
    // A partial download in the transfer folder stays put while it waits.
    const part = path.join(paused.outputDir, 'download.zip.part')
    fs.writeFileSync(part, 'partial')

    const done = await settle(manager, ['completed', 'failed'])
    expect(done.stage).toBe('completed')
    expect(done.waitingForDatabase).toBeUndefined()
    // It checked /api/status until the database was back: down, then up.
    expect(requests.filter((r) => r === '/api/status')).toHaveLength(2)
    manager.cleanup()
  }, 20000)

  it('replies with the maintenance message instead of a plain error', async () => {
    const { manager } = makeManager({
      '/api/getList': [
        new DatabaseRequestError(
          'Moving servers',
          503,
          'maintenance',
          120,
          '2026-10-14T18:00:00.000Z',
        ),
      ],
    })
    const reply = await send(manager, {
      action: 'search',
      filters: defaultDatabaseFilters,
      page: 1,
    })
    expect(reply.maintenance).toEqual({
      message: 'Moving servers',
      since: '2026-10-14T18:00:00.000Z',
    })
    manager.cleanup()
  })

  it('starts a new export only after an explicit Resume when the old one expired', async () => {
    const { manager, requests } = makeManager({
      create: [
        { jobId: 'a'.repeat(24), token: 't1' },
        { jobId: 'b'.repeat(24), token: 't2' },
      ],
      status: [
        { status: 'completed', downloadReady: false },
        { status: 'completed', downloadReady: true },
      ],
      file: [{ url: 'https://s3.us-east-005.backblazeb2.com/b/y.zip' }],
    })
    manager.downloadReplays([rid('ha'), rid('hb')], 'Two missing replays')

    const gone = await settle(manager, ['failed', 'completed'])
    expect(gone.stage).toBe('failed')
    expect(gone.exportGone).toBe(true)
    expect(gone.error).toMatch(/Resume to start a new export/)

    await send(manager, { action: 'resume', id: gone.id })
    const done = await settle(manager, ['completed'])
    expect(done.exportGone).toBeUndefined()
    // A second create happened only after the explicit Resume.
    expect(requests.filter((r) => r.includes('action=create'))).toHaveLength(2)
    manager.cleanup()
  }, 20000)

  it('downloads replays by id into the library without importing them', async () => {
    const done: unknown[] = []
    const { manager, bodies } = makeManager(
      {
        create: [{ jobId: 'c'.repeat(24), token: 't3' }],
        status: [{ status: 'completed', downloadReady: true }],
        file: [{ url: 'https://s3.us-east-005.backblazeb2.com/b/z.zip' }],
      },
      (job) => done.push(job),
    )
    const ids = [rid('ha'), rid('hb')]
    const created = manager.downloadReplays(
      ids,
      'Download 2 missing replays again',
    )
    expect(created.title).toBe('Download 2 missing replays again')
    const job = await settle(manager, ['completed', 'failed'])
    expect(job.stage).toBe('completed')
    // The export asked for exactly these replays, not a filter, with CPU
    // games allowed (else any among them would come back "missing").
    expect(bodies[0]).toEqual({ replayIds: ids, includeCpu: true })
    // Into the library, not into the open project.
    expect(imported).toEqual([])
    expect(library.rows.size).toBe(2)
    expect(done).toHaveLength(1)
    // The saved history round-trips (replayIds instead of filters is valid).
    const saved = JSON.parse(
      fs.readFileSync(path.join(dir, 'transfers.json'), 'utf8'),
    )
    expect(() => parseSavedTransfer(saved.jobs[0])).not.toThrow()
    expect(() =>
      parseSavedTransfer({ ...saved.jobs[0], replayIds: ['../x'] }),
    ).toThrow(/replayIds/)
    manager.cleanup()
  }, 20000)

  const lunarClip = (replayId: string, n: number) => ({
    id: `clip-${n}`,
    replayId,
    type: 'combo',
    startFrame: 100,
    endFrame: 200,
    stageId: 31,
    startAt: null,
    attacker: { port: 0, characterId: 2, connectCode: null, displayName: null },
    victim: { port: 1, characterId: 9, connectCode: null, displayName: null },
    startPercent: 0,
    endPercent: 50,
    damage: 50,
    moves: 3,
    didKill: false,
    score: null,
    metrics: null,
    moveList: [[1, 100, 10, 1]],
  })

  it('adds clips: downloads only games the library lacks, imports all, adds the clips', async () => {
    addedClips.length = 0
    // The library already has game "ha" from an earlier download.
    const haPath = path.join(library.folder, libraryRelativePath(rid('ha')))
    fs.mkdirSync(path.dirname(haPath), { recursive: true })
    fs.writeFileSync(haPath, 'a')
    await library.register([
      { replayId: rid('ha'), fileHash: 'ha', path: haPath },
    ])
    const { manager, requests, replayCalls, replayOpts } = makeManager(
      {},
      undefined,
      { directMaxGames: 24, replay: (id) => slpOf(id) },
    )
    const reply = await send(manager, {
      action: 'addClips',
      clips: [
        lunarClip(rid('ha'), 1),
        lunarClip(rid('hb'), 2),
        lunarClip(rid('hb'), 3),
      ],
    })
    expect(reply.error).toBeUndefined()
    const job = await settle(manager, ['completed', 'failed'])
    expect(job.stage).toBe('completed')
    expect(job.title).toBe('Add 3 clips to “Project”')
    // Only the missing game, one by one from storage only: no export, no server.
    expect(requests).toEqual([])
    expect(replayCalls).toEqual([rid('hb')])
    expect(replayOpts).toEqual([{ storedOnly: true }])
    const hbPath = path.join(library.folder, libraryRelativePath(rid('hb')))
    // Both games go into the project, then the three clips.
    expect(imported[0].sort()).toEqual([haPath, hbPath].sort())
    expect(addedClips[0].clips).toHaveLength(3)
    expect(addedClips[0].paths).toEqual({
      [rid('ha')]: haPath,
      [rid('hb')]: hbPath,
    })
    expect(job.detail).toBe('3 clips added')
    manager.cleanup()
  }, 20000)

  it('adds clips without any download when the library has every game', async () => {
    addedClips.length = 0
    const haPath = path.join(library.folder, libraryRelativePath(rid('ha')))
    fs.mkdirSync(path.dirname(haPath), { recursive: true })
    fs.writeFileSync(haPath, 'a')
    await library.register([
      { replayId: rid('ha'), fileHash: 'ha', path: haPath },
    ])
    const { manager, requests } = makeManager({})
    await send(manager, {
      action: 'addClips',
      clips: [lunarClip(rid('ha'), 1)],
    })
    const job = await settle(manager, ['completed', 'failed'])
    expect(job.stage).toBe('completed')
    expect(requests).toEqual([])
    expect(addedClips[0].clips).toHaveLength(1)
    manager.cleanup()
  }, 20000)

  it('rejects malformed clips from the renderer', async () => {
    const { manager } = makeManager({})
    const reply = await send(manager, {
      action: 'addClips',
      clips: [{ ...lunarClip(rid('ha'), 1), replayId: '../../etc' }],
    })
    expect(reply.error).toBe('Invalid clip data.')
    expect(manager.list()).toHaveLength(0)
    manager.cleanup()
  })

  it('removes a finished transfer and keeps the replays it brought in', async () => {
    const { manager } = makeManager({
      create: [{ jobId: 'c'.repeat(24), token: 't3' }],
      status: [{ status: 'completed', downloadReady: true }],
      file: [{ url: 'https://s3.us-east-005.backblazeb2.com/b/z.zip' }],
    })
    manager.downloadReplays([rid('ha'), rid('hb')], 'Two replays')
    const job = await settle(manager, ['completed', 'failed'])
    expect(job.stage).toBe('completed')
    const reply = await send(manager, { action: 'remove', id: job.id })
    expect(reply.transfers).toEqual([])
    expect(manager.list()).toEqual([])
    for (const { path: p } of library.rows.values())
      expect(fs.existsSync(p)).toBe(true)
    const saved = JSON.parse(
      fs.readFileSync(path.join(dir, 'transfers.json'), 'utf8'),
    )
    expect(saved.jobs).toEqual([])
    manager.cleanup()
  }, 20000)

  it('removing an unfinished transfer deletes its partial download', async () => {
    const { manager } = makeManager({
      create: [new Error('boom')],
    })
    manager.downloadReplays([rid('ha'), rid('hb')], 'Two missing replays')
    const job = await settle(manager, ['failed'])
    const part = path.join(job.outputDir, 'download.zip.part')
    const other = path.join(job.outputDir, 'keep.txt')
    fs.writeFileSync(part, 'partial')
    fs.writeFileSync(other, 'x')
    await send(manager, { action: 'remove', id: job.id })
    expect(fs.existsSync(part)).toBe(false)
    expect(fs.existsSync(other)).toBe(true)
    manager.cleanup()
  }, 20000)

  it('clears only finished transfers', async () => {
    const { manager } = makeManager({
      create: [{ jobId: 'c'.repeat(24), token: 't3' }, new Error('boom')],
      status: [{ status: 'completed', downloadReady: true }],
      file: [{ url: 'https://s3.us-east-005.backblazeb2.com/b/z.zip' }],
    })
    manager.downloadReplays([rid('ha')], 'Done one')
    await settle(manager, ['completed'])
    manager.downloadReplays([rid('hb')], 'Fails')
    await settle(manager, ['failed'])
    const reply = await send(manager, { action: 'clearFinished' })
    expect(reply.transfers.map((t: { stage: string }) => t.stage)).toEqual([
      'failed',
    ])
    manager.cleanup()
  }, 20000)

  it('marks search results already in the library', async () => {
    const haPath = path.join(library.folder, libraryRelativePath(rid('ha')))
    fs.mkdirSync(path.dirname(haPath), { recursive: true })
    fs.writeFileSync(haPath, 'a')
    await library.register([
      { replayId: rid('ha'), fileHash: 'ha', path: haPath },
    ])
    const { manager } = makeManager({})
    ;(manager as unknown as { client: unknown }).client = {
      json: async (route: string) =>
        route === '/api/getList'
          ? {
              results: [
                { _id: rid('ha') },
                { _id: rid('hb') },
                { _id: 'x', fileHash: 'ha' },
              ],
            }
          : {
              results: [lunarClip(rid('ha'), 1), lunarClip(rid('hb'), 2)],
              total: 2,
            },
    }
    const found = await send(manager, {
      action: 'search',
      filters: defaultDatabaseFilters,
      page: 1,
    })
    expect(
      found.search.results.map((r: { inLibrary?: boolean }) => !!r.inLibrary),
    ).toEqual([true, false, true])
    const clips = await send(manager, {
      action: 'clipSearch',
      search: defaultClipSearch,
      page: 1,
    })
    expect(
      clips.clips.results.map((c: { inLibrary?: boolean }) => !!c.inLibrary),
    ).toEqual([true, false])
    manager.cleanup()
  })

  it('Find replays and Find clips ask for stored games only', async () => {
    const { manager, bodies } = makeManager({
      '/api/getList': [{ results: [], total: 0 }],
      '/api/clips': [{ results: [], total: 0 }],
    })
    await send(manager, {
      action: 'search',
      filters: defaultDatabaseFilters,
      page: 1,
    })
    await send(manager, {
      action: 'clipSearch',
      search: defaultClipSearch,
      page: 1,
    })
    expect(bodies[0]).toMatchObject({ storedOnly: true })
    expect(bodies[1]).toMatchObject({
      storedOnly: true,
      type: defaultClipSearch.type,
    })
    manager.cleanup()
  })

  it('adds chosen games: downloads only the missing ones, imports all', async () => {
    const haPath = path.join(library.folder, libraryRelativePath(rid('ha')))
    fs.mkdirSync(path.dirname(haPath), { recursive: true })
    fs.writeFileSync(haPath, 'a')
    await library.register([
      { replayId: rid('ha'), fileHash: 'ha', path: haPath },
    ])
    const { manager, requests, replayCalls, replayOpts } = makeManager(
      {},
      undefined,
      {
        directMaxGames: 24,
        // hc is newer than the stored games: the website says 404 (storedOnly).
        replay: (id) =>
          id === rid('hc')
            ? new DatabaseRequestError('Not stored yet', 404, 'not_found')
            : slpOf(id),
      },
    )
    const reply = await send(manager, {
      action: 'addReplays',
      replayIds: [rid('ha'), rid('hb'), rid('hc')],
    })
    expect(reply.transfers[0].title).toBe('Add 3 games to “Project”')
    const job = await settle(manager, ['completed', 'failed'])
    expect(job.stage).toBe('completed')
    expect(requests).toEqual([])
    expect(replayCalls.sort()).toEqual([rid('hb'), rid('hc')].sort())
    expect(replayOpts.every((o) => o.storedOnly === true)).toBe(true)
    expect(imported.at(-1)!.sort()).toEqual(
      ['ha', 'hb']
        .map((h) => path.join(library.folder, libraryRelativePath(rid(h))))
        .sort(),
    )
    manager.cleanup()
  }, 20000)

  describe('game by game (no export queue)', () => {
    const slp = (tag: string) =>
      Buffer.concat([Buffer.from('{U\x03raw[$U#l', 'latin1'), Buffer.from(tag)])
    const notFound = () =>
      new DatabaseRequestError('Replay not found', 404, undefined)

    it('fetches missing games straight into the library and imports all of them', async () => {
      const haPath = path.join(library.folder, libraryRelativePath(rid('ha')))
      fs.mkdirSync(path.dirname(haPath), { recursive: true })
      fs.writeFileSync(haPath, 'a')
      await library.register([
        { replayId: rid('ha'), fileHash: 'ha', path: haPath },
      ])
      const { manager, requests, replayCalls } = makeManager({}, undefined, {
        directMaxGames: 200,
        replay: (id) => (id === rid('hc') ? notFound() : slp(id)),
      })
      await send(manager, {
        action: 'addReplays',
        replayIds: [rid('ha'), rid('hb'), rid('hc')],
      })
      const job = await settle(manager, ['completed', 'failed'])
      expect(job.stage).toBe('completed')
      expect(requests).toEqual([]) // no export, no queue
      expect(replayCalls.sort()).toEqual([rid('hb'), rid('hc')].sort())
      const hbPath = path.join(library.folder, libraryRelativePath(rid('hb')))
      expect(fs.readFileSync(hbPath).equals(slp(rid('hb')))).toBe(true)
      expect(library.rows.get(rid('hb'))?.path).toBe(hbPath)
      expect(imported.at(-1)!.sort()).toEqual([haPath, hbPath].sort())
      manager.cleanup()
    }, 20000)

    it('waits out a busy server, and stops on real failures so Resume can finish the rest', async () => {
      let busy = 1
      let broken = true
      const { manager, replayCalls } = makeManager({}, undefined, {
        directMaxGames: 200,
        replay: (id) => {
          if (id === rid('ha') && busy-- > 0)
            return new DatabaseRequestError('busy', 429, 'rate_limited', 1)
          if (id === rid('hb') && broken)
            return new DatabaseRequestError('boom', 400, undefined)
          return slp(id)
        },
      })
      manager.downloadReplays([rid('ha'), rid('hb')], 'Two games')
      const failed = await settle(manager, ['failed', 'completed'])
      expect(failed.stage).toBe('failed')
      expect(library.rows.has(rid('ha'))).toBe(true) // kept
      broken = false
      const before = replayCalls.length
      await send(manager, { action: 'resume', id: failed.id })
      const done = await settle(manager, ['completed'])
      expect(done.stage).toBe('completed')
      // Only the missing game was fetched again.
      expect(replayCalls.slice(before)).toEqual([rid('hb')])
      manager.cleanup()
    }, 30000)

    it('waits out a 502 and a 504 from the website instead of failing (DL-7)', async () => {
      const seen: Record<string, number> = {}
      const { manager } = makeManager({}, undefined, {
        directMaxGames: 200,
        replay: (id) => {
          seen[id] = (seen[id] ?? 0) + 1
          if (id === rid('ha') && seen[id] === 1)
            return new DatabaseRequestError(
              'Database API is not running',
              502,
              undefined,
              1,
            )
          if (id === rid('hb') && seen[id] === 1)
            return new DatabaseRequestError(
              'Database API timed out',
              504,
              undefined,
              1,
            )
          return slp(id)
        },
      })
      manager.downloadReplays([rid('ha'), rid('hb')], 'Two games')
      const job = await settle(manager, ['completed', 'failed', 'paused'])
      expect(job.stage).toBe('completed')
      expect(seen[rid('ha')]).toBe(2)
      expect(seen[rid('hb')]).toBe(2)
      manager.cleanup()
    }, 30000)

    it('skips a replay too large to fetch, counts it, and still finishes (DL-11)', async () => {
      const { manager, replayCalls } = makeManager({}, undefined, {
        directMaxGames: 200,
        replay: (id) =>
          id === rid('hb') ? new ReplayTooLargeError() : slp(id),
      })
      await send(manager, {
        action: 'addReplays',
        replayIds: [rid('ha'), rid('hb')],
      })
      const job = await settle(manager, ['completed', 'failed', 'paused'])
      expect(job.stage).toBe('completed')
      // Not retried: one request for the big one.
      expect(replayCalls.filter((id) => id === rid('hb'))).toHaveLength(1)
      expect(job.detail).toMatch(/1 could not be downloaded/)
      manager.cleanup()
    }, 20000)

    it('a full drive pauses the transfer with a plain message (DL-3, UX-4)', async () => {
      const { manager } = makeManager({}, undefined, {
        directMaxGames: 200,
        replay: () =>
          Object.assign(new Error('ENOSPC: no space left on device, write'), {
            code: 'ENOSPC',
            syscall: 'write',
          }),
      })
      manager.downloadReplays([rid('ha')], 'One game')
      const job = await settle(manager, ['completed', 'failed', 'paused'])
      expect(job.stage).toBe('paused')
      expect(job.detail).toMatch(/drive.*full/)
      expect(job.detail).not.toMatch(/ENOSPC/)
      manager.cleanup()
    }, 20000)

    it('rides out a short loss of connection without stopping', async () => {
      let offline = 2
      const { manager } = makeManager({}, undefined, {
        directMaxGames: 200,
        replay: (id) => {
          if (id === rid('ha') && offline-- > 0) {
            // What Node gives when neither the IPv4 nor the IPv6 address answers.
            const e = new AggregateError(
              [
                Object.assign(new Error('connect EACCES'), { code: 'EACCES' }),
                Object.assign(new Error('connect EACCES'), { code: 'EACCES' }),
              ],
              '',
            )
            return e as unknown as Error
          }
          return slp(id)
        },
      })
      manager.downloadReplays([rid('ha')], 'One game')
      const done = await settle(manager, ['failed', 'completed'])
      expect(done.stage).toBe('completed')
      manager.cleanup()
    }, 30000)

    it('still uses a bundle above the limit', async () => {
      const { manager, requests, replayCalls } = makeManager(
        {
          create: [{ jobId: 'e'.repeat(24), token: 't5' }],
          status: [{ status: 'completed', downloadReady: true }],
          file: [{ url: 'https://s3.us-east-005.backblazeb2.com/b/v.zip' }],
        },
        undefined,
        { directMaxGames: 1, replay: (id) => slp(id) },
      )
      manager.downloadReplays([rid('ha'), rid('hb')], 'Two games')
      await settle(manager, ['completed', 'failed'])
      expect(requests[0]).toMatch(/action=create/)
      expect(replayCalls).toEqual([])
      manager.cleanup()
    }, 20000)

    it('a small Find replays batch takes the first games of the search, one by one', async () => {
      const { manager, requests, bodies, replayCalls, replayOpts } =
        makeManager(
          {
            '/api/getList': [
              { results: [{ _id: rid('ha') }, { _id: rid('hb') }], total: 2 },
            ],
          },
          undefined,
          { directMaxGames: 200, replay: (id) => slp(id) },
        )
      await send(manager, {
        action: 'start',
        filters: { ...defaultDatabaseFilters, maxFiles: 200 },
      })
      const job = await settle(manager, ['completed', 'failed'])
      expect(job.stage).toBe('completed')
      expect(requests).toEqual(['/api/getList']) // no export, no queue
      // The newest stored games, each from storage only.
      expect(bodies[0]).toMatchObject({
        page: 1,
        numPerPage: 200,
        storedOnly: true,
      })
      expect(replayCalls.sort()).toEqual([rid('ha'), rid('hb')].sort())
      expect(replayOpts).toEqual([{ storedOnly: true }, { storedOnly: true }])
      manager.cleanup()
    }, 20000)

    it('sends includeCpu with a search only when Include CPU games is on', async () => {
      const { manager, bodies } = makeManager(
        {
          '/api/getList': [
            { results: [{ _id: rid('ha') }], total: 1 },
            { results: [{ _id: rid('ha') }], total: 1 },
          ],
        },
        undefined,
        { directMaxGames: 200, replay: (id) => slp(id) },
      )
      await send(manager, {
        action: 'search',
        filters: { ...defaultDatabaseFilters, maxFiles: 200 },
        page: 1,
      })
      await send(manager, {
        action: 'search',
        filters: { ...defaultDatabaseFilters, maxFiles: 200, includeCpu: true },
        page: 1,
      })
      expect(bodies[0]).not.toHaveProperty('includeCpu')
      expect(bodies[1]).toMatchObject({ includeCpu: true, page: 1 })
      manager.cleanup()
    }, 20000)
  })

  it('adds a finished transfer to the project open now, without downloading', async () => {
    const haPath = path.join(library.folder, libraryRelativePath(rid('ha')))
    fs.mkdirSync(path.dirname(haPath), { recursive: true })
    fs.writeFileSync(haPath, 'a')
    await library.register([
      { replayId: rid('ha'), fileHash: 'ha', path: haPath },
    ])
    const { manager, requests } = makeManager({})
    await send(manager, { action: 'addReplays', replayIds: [rid('ha')] })
    const first = await settle(manager, ['completed', 'failed'])
    expect(first.stage).toBe('completed')
    expect(first.canImport).toBe(true)
    project = { path: path.join(dir, 'other.lcp'), name: 'Other' }
    const before = imported.length
    await send(manager, { action: 'addToProject', id: first.id })
    await new Promise((resolve) => {
      setTimeout(resolve, 50)
    })
    const again = await settle(manager, ['completed', 'failed'])
    expect(again.projectName).toBe('Other')
    expect(imported.length).toBe(before + 1)
    expect(imported.at(-1)).toEqual([haPath])
    expect(requests).toEqual([])
    manager.cleanup()
  }, 20000)

  it('rejects malformed game selections', async () => {
    const { manager } = makeManager({})
    for (const replayIds of [[], ['../x'], 'abc']) {
      const reply = await send(manager, { action: 'addReplays', replayIds })
      expect(reply.error).toBe('Invalid replay selection.')
    }
    manager.cleanup()
  })
})

describe('cancel and the live countdown', () => {
  it('keeps a canceled download canceled across a restart', () => {
    const job = parseSavedTransfer({
      id: '6f1c2c1e-1111-4222-8333-944455556666',
      kind: 'database',
      title: 'Up to 10 Lunar replays',
      detail: 'Canceled. Nothing was kept.',
      stage: 'canceled',
      createdAt: 1,
      current: 0,
      total: null,
      outputDir: '/home/u/Replays/Lunar-2026',
      filters: defaultDatabaseFilters,
    })
    expect(recoverTransfer(job).stage).toBe('canceled')
    expect(
      parseDatabaseRequest({
        action: 'cancel',
        id: '6f1c2c1e-1111-4222-8333-944455556666',
      }),
    ).toEqual({ action: 'cancel', id: '6f1c2c1e-1111-4222-8333-944455556666' })
  })

  it('turns the server estimate into a ready time', () => {
    const now = 1_000_000
    expect(
      readyAtOf(
        {
          status: 'pending',
          estimatedWaitSec: 600,
          estimatedProcessingTimeSec: 60,
        } as any,
        now,
      ),
    ).toBe(now + 660_000)
    expect(
      readyAtOf(
        { status: 'processing', estimatedProcessingTimeSec: 30 } as any,
        now,
      ),
    ).toBe(now + 30_000)
    expect(readyAtOf({ status: 'pending' } as any, now)).toBeNull()
    expect(
      readyAtOf(
        {
          status: 'pending',
          estimatedWaitSec: 60,
          paused: 'maintenance',
        } as any,
        now,
      ),
    ).toBeNull()
  })
})
