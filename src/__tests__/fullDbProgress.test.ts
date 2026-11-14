/** @jest-environment node */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { FullDbProgressReporter, REPORT_EVERY_MS } from '../main/fullDbProgress'

// The whole-database download in TransferManager: links come with a downloadId +
// token, progress is reported, and a fresh link keeps the same record.
const mockState: {
  downloads: string
  onBytes: number[]
  expireFirst: boolean
} = { downloads: '', onBytes: [], expireFirst: false }

jest.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => mockState.downloads,
    getVersion: () => '9.9.9',
  },
  dialog: {},
  shell: {},
}))

jest.mock('../main/databaseClient', () => {
  const actual = jest.requireActual('../main/databaseClient')
  return {
    ...actual,
    downloadBundle: jest.fn(
      async (
        _url: string,
        destination: string,
        _signal: AbortSignal,
        onProgress: (_b: number, _t: number | null) => void,
      ) => {
        if (mockState.expireFirst) {
          mockState.expireFirst = false
          onProgress(400, 1000)
          throw new actual.DownloadLinkExpiredError()
        }
        for (const b of mockState.onBytes) onProgress(b, 1000)
        // eslint-disable-next-line global-require
        require('fs').writeFileSync(destination, Buffer.alloc(1000))
      },
    ),
  }
})

// eslint-disable-next-line import/first
import TransferManager from '../main/managers/TransferManager'

const flush = () =>
  new Promise((resolve) => {
    setTimeout(resolve, 0)
  })

describe('FullDbProgressReporter', () => {
  it('reports the first bytes, then every 5% or 5 minutes, one at a time', async () => {
    const sent: [number, boolean][] = []
    let now = 0
    const reporter = new FullDbProgressReporter(
      async (b, d) => {
        sent.push([b, d])
      },
      1000,
      () => now,
    )
    reporter.onBytes(10)
    await flush()
    reporter.onBytes(40) // < 5% more
    await flush()
    reporter.onBytes(60) // 5% more
    await flush()
    now += REPORT_EVERY_MS
    reporter.onBytes(61) // 5 minutes on
    await flush()
    reporter.onBytes(61) // nothing new
    expect(sent).toEqual([
      [10, false],
      [60, false],
      [61, false],
    ])
  })

  it('never lets a failing report stop the download, and retries the finish', async () => {
    let calls = 0
    const reporter = new FullDbProgressReporter(async () => {
      calls += 1
      if (calls < 3) throw new Error('offline')
    }, 1000)
    reporter.onBytes(1)
    await flush()
    expect(await reporter.finish(1000, 1)).toBe(true)
    expect(calls).toBe(3)
  })
})

describe('whole-database transfer', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lunar-fulldb-'))
    mockState.downloads = path.join(dir, 'Downloads')
    fs.mkdirSync(mockState.downloads)
    mockState.onBytes = [100, 200, 500, 1000]
    mockState.expireFirst = false
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  function makeManager() {
    const manager = new TransferManager(
      { isDestroyed: () => false, webContents: { send: () => {} } } as never,
      {
        configDir: dir,
        getArchive: () => null as never,
        ensureProject: async () => undefined,
        getSlpzBinary: () => 'slpz',
        getLibrary: () => null as never,
        addClips: async () => ({ added: 0, unavailable: 0 }),
        importer: { importInProgress: false } as never,
      },
    )
    const calls: { route: string; body?: any; headers?: any }[] = []
    let links = 0
    ;(manager as unknown as { client: unknown }).client = {
      json: jest.fn(
        async (
          route: string,
          body?: unknown,
          _token?: string,
          _signal?: AbortSignal,
          headers?: Record<string, string>,
        ) => {
          calls.push({ route, body, headers })
          if (route.startsWith('/api/download?action=bundles'))
            return {
              bundles: [{ fullDb: true, bundleSize: 1000, replayCount: 5 }],
            }
          if (route === '/api/clipper?action=full-db') {
            links += 1
            return links === 1
              ? {
                  url: 'https://dl.lunarmelee.com/a.zip',
                  downloadId: 'f'.repeat(24),
                  token: 'tok_tok_tok_tok_tok_tok_',
                }
              : {
                  url: 'https://dl.lunarmelee.com/a.zip',
                  downloadId: 'f'.repeat(24),
                }
          }
          if (route === '/api/clipper?action=full-db-progress')
            return { status: 'downloading' }
          throw new Error(`unexpected ${route}`)
        },
      ),
    }
    return { manager, calls }
  }

  async function send(manager: TransferManager, payload: unknown) {
    await manager.handle({ reply: () => {} } as never, {
      requestId: 'r1',
      payload,
    })
  }

  async function settle(manager: TransferManager) {
    for (let i = 0; i < 500; i++) {
      const job = manager.list()[0]
      if (job && ['completed', 'failed'].includes(job.stage)) return job
      await new Promise((resolve) => {
        setTimeout(resolve, 10)
      })
    }
    throw new Error('never finished')
  }

  it('reports progress and completion with the link’s token', async () => {
    const { manager, calls } = makeManager()
    await send(manager, { action: 'downloadFullDb' })
    const job = await settle(manager)
    expect(job.stage).toBe('completed')
    const link = calls.find((c) => c.route === '/api/clipper?action=full-db')!
    // The app version goes on every request in DatabaseClient (clientIdentity.ts).
    expect(link.headers).toEqual({})
    const reports = calls
      .filter((c) => c.route === '/api/clipper?action=full-db-progress')
      .map((c) => c.body)
    expect(reports[0]).toEqual({
      downloadId: 'f'.repeat(24),
      token: 'tok_tok_tok_tok_tok_tok_',
      bytesDone: 100,
      done: false,
    })
    expect(reports.at(-1)).toEqual({
      downloadId: 'f'.repeat(24),
      token: 'tok_tok_tok_tok_tok_tok_',
      bytesDone: 1000,
      done: true,
    })
    // The token never reaches the renderer.
    expect(JSON.stringify(manager.list())).not.toContain('tok_tok')
    manager.cleanup()
  })

  it('an older snapshot already in Downloads does not block a new download (DL-25)', async () => {
    fs.writeFileSync(
      path.join(mockState.downloads, 'lunar-melee-full-database.zip'),
      'old snapshot',
    )
    const { manager } = makeManager()
    await send(manager, { action: 'downloadFullDb' })
    expect((await settle(manager)).stage).toBe('completed')
    // The old file is untouched; the new one has a dated name beside it.
    expect(
      fs.readFileSync(
        path.join(mockState.downloads, 'lunar-melee-full-database.zip'),
        'utf8',
      ),
    ).toBe('old snapshot')
    const names = fs.readdirSync(mockState.downloads)
    expect(
      names.some((n) =>
        /^lunar-melee-full-database-\d{4}-\d{2}-\d{2}\.zip$/.test(n),
      ),
    ).toBe(true)
    manager.cleanup()
  })

  it('a file of the same size is the same snapshot: you already have it', async () => {
    const { manager } = makeManager()
    fs.writeFileSync(
      path.join(mockState.downloads, 'lunar-melee-full-database.zip'),
      Buffer.alloc(1000),
    )
    let reply: { error?: string } = {}
    await manager.handle(
      {
        reply: (_c: string, body: { payload: { error?: string } }) => {
          reply = body.payload
        },
      } as never,
      { requestId: 'r2', payload: { action: 'downloadFullDb' } },
    )
    expect(reply.error).toMatch(/already have it/)
    manager.cleanup()
  })

  it('a fresh link after one expires keeps the same download record', async () => {
    mockState.expireFirst = true
    const { manager, calls } = makeManager()
    await send(manager, { action: 'downloadFullDb' })
    expect((await settle(manager)).stage).toBe('completed')
    const links = calls.filter((c) => c.route === '/api/clipper?action=full-db')
    expect(links).toHaveLength(2)
    expect(links[1].headers['X-Full-Db-Download']).toBe(
      `${'f'.repeat(24)}.tok_tok_tok_tok_tok_tok_`,
    )
    const last = calls.filter(
      (c) => c.route === '/api/clipper?action=full-db-progress',
    )
    expect(last.at(-1)!.body.done).toBe(true)
    manager.cleanup()
  })
})
