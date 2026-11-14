/**
 * @jest-environment node
 *
 * Prebuilt plans for direct downloads: the shared plan-file codec, the manifest
 * match, and filling a transfer's plan from a file served like the plans host.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import crypto from 'crypto'
import zlib from 'zlib'
import {
  decodePlanFile,
  encodePlanFile,
  findPrebuiltPlan,
  selectionKey,
  type PlanManifest,
  type PlanRow,
} from '../vendor/direct-plan'
import {
  DirectPlan,
  buildPlan,
  type LocationsPage,
} from '../main/directDownload'
import {
  _resetManifestCache,
  loadPrebuiltPlan,
  planUrlAllowed,
} from '../main/prebuiltPlans'

const SNAP = {
  id: 'archive/lunar_db_full.zip@e1-2',
  key: 'archive/lunar_db_full.zip',
  etag: 'e1-2',
  size: 1e12,
  kind: 'full' as const,
}
const DELTA = {
  id: 'archive/delta/d.zip@d',
  key: 'archive/delta/d.zip',
  etag: 'd',
  size: 1e9,
  kind: 'delta' as const,
}
const id = (n: number) => n.toString(16).padStart(24, '0')

function rows(n: number): PlanRow[] {
  const out: PlanRow[] = []
  let at = 2 ** 39 // past 4 GB: offsets need more than 32 bits
  for (let i = 0; i < n; i++) {
    const header = at + (i % 4 === 0 ? 70_000 : 0)
    const length = 1000 + ((i * 7919) % 400_000)
    out.push({
      id: id(1000 + i),
      hash:
        i % 5 ? crypto.createHash('md5').update(String(i)).digest('hex') : '',
      zip: 0,
      header,
      offset: header + 30 + 25 + (i % 3),
      length,
    })
    at = header + 30 + 25 + (i % 3) + length
  }
  return out
}

describe('plan files', () => {
  it('round-trip every field, in (zip, offset) order, with the other ids', () => {
    const games = rows(3000).reverse()
    const file = encodePlanFile(
      { snapshots: [SNAP], filter: { p1CharacterId: '2' }, builtAt: 'now' },
      games,
      [id(1), id(2)],
    )
    const back = decodePlanFile(file)
    expect(back.meta).toMatchObject({
      count: 3000,
      other: 2,
      filter: { p1CharacterId: '2' },
    })
    expect(back.games).toEqual([...games].sort((a, b) => a.offset - b.offset))
    expect(back.other).toEqual([id(1), id(2)])
    // Smaller than the JSON pages it replaces, by a lot.
    expect(file.length).toBeLessThan(JSON.stringify(games).length / 3)
  })

  it('refuse damaged files', () => {
    const file = encodePlanFile(
      { snapshots: [SNAP], filter: {}, builtAt: 'x' },
      rows(10),
    )
    expect(() => decodePlanFile(file.subarray(0, file.length - 3))).toThrow()
    expect(() =>
      decodePlanFile(Buffer.concat([file, Buffer.from([0])])),
    ).toThrow()
    expect(() => decodePlanFile(Buffer.from('nope'))).toThrow()
  })
})

describe('manifest match', () => {
  const manifest: PlanManifest = {
    v: 1,
    snapshot: SNAP.id,
    builtAt: 'x',
    plans: [
      {
        filter: { p1CharacterId: '2' },
        file: 'char/fox.ldp.br',
        sha256: '',
        size: 1,
        encoding: 'br',
        games: 10,
        selected: 12,
        bytes: 1,
      },
      {
        filter: { p1CharacterId: '9' },
        file: 'char/marth.ldp.br',
        sha256: '',
        size: 1,
        encoding: 'br',
        games: 5,
        selected: 5,
        bytes: 1,
      },
    ],
  }

  it('the same selection asking for all of it', () => {
    expect(
      findPrebuiltPlan(manifest, {
        p1CharacterId: '2',
        maxFiles: 12,
        sort: 'startAt:-1',
      })?.file,
    ).toBe('char/fox.ldp.br')
    expect(
      findPrebuiltPlan(manifest, {
        p1CharacterId: '2',
        maxFiles: 50_000,
        sort: 'startAt:1',
      })?.file,
    ).toBe('char/fox.ldp.br')
    expect(findPrebuiltPlan(manifest, { p1CharacterId: '9' })?.file).toBe(
      'char/marth.ldp.br',
    )
  })

  it('never a part of it, another selection, a list or another snapshot', () => {
    expect(
      findPrebuiltPlan(manifest, { p1CharacterId: '2', maxFiles: 11 }),
    ).toBeNull()
    expect(
      findPrebuiltPlan(manifest, {
        p1CharacterId: '2',
        source: 'ranked',
        maxFiles: 99,
      }),
    ).toBeNull()
    expect(
      findPrebuiltPlan(manifest, { p1CharacterId: '2,9', maxFiles: 99 }),
    ).toBeNull()
    expect(
      findPrebuiltPlan(manifest, {
        replayIds: [id(1)] as never,
        p1CharacterId: '2',
      }),
    ).toBeNull()
    expect(findPrebuiltPlan(manifest, { maxFiles: 99 })).toBeNull()
    expect(
      findPrebuiltPlan(
        manifest,
        { p1CharacterId: '2' },
        'archive/lunar_db_full.zip@new',
      ),
    ).toBeNull()
  })

  it('selection keys ignore order, limits and empty fields', () => {
    expect(
      selectionKey({ b: '2,1', a: true, maxFiles: 5, sort: 'x', c: '' }),
    ).toBe(selectionKey({ a: true, b: '1,2' }))
  })

  it('production allows only the plans host over HTTPS', () => {
    expect(
      planUrlAllowed('https://plans.lunarmelee.com/v1/manifest.json'),
    ).toBe(true)
    expect(planUrlAllowed('http://plans.lunarmelee.com/v1/manifest.json')).toBe(
      false,
    )
    expect(planUrlAllowed('https://plans.lunarmelee.com.evil.test/x')).toBe(
      false,
    )
  })
})

describe('loadPrebuiltPlan', () => {
  let dir: string
  let base: string
  let server: http.Server
  const files = new Map<string, Buffer>()
  const served: string[] = []
  const games = rows(45_000) // more than one internal page

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lunar-prebuilt-'))
    server = http.createServer((req, res) => {
      served.push(req.url!)
      const f = files.get(req.url!)
      if (f) res.end(f)
      else res.writeHead(404).end()
    })
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve())
    })
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function publish(opts: { sha?: string; snapshot?: string } = {}) {
    const br = zlib.brotliCompressSync(
      encodePlanFile(
        { snapshots: [SNAP], filter: { p1CharacterId: '2' }, builtAt: 'x' },
        games,
      ),
    )
    files.set('/v1/char/fox.ldp.br', br)
    files.set(
      '/v1/manifest.json',
      Buffer.from(
        JSON.stringify({
          v: 1,
          snapshot: opts.snapshot ?? SNAP.id,
          builtAt: 'x',
          plans: [
            {
              filter: { p1CharacterId: '2' },
              file: 'char/fox.ldp.br',
              sha256:
                opts.sha ??
                crypto.createHash('sha256').update(br).digest('hex'),
              size: br.length,
              encoding: 'br',
              games: games.length,
              selected: games.length + 2,
              bytes: 0,
            },
          ],
        }),
      ),
    )
    _resetManifestCache()
  }

  const load = (plan: DirectPlan, filter: Record<string, unknown>) =>
    loadPrebuiltPlan(plan, {
      manifestUrl: `${base}/v1/manifest.json`,
      filter,
      signal: new AbortController().signal,
      allowUrl: () => true,
    })

  it('fills the plan, then the listing asks only for the rest and drops full-DB rows', async () => {
    publish()
    const plan = DirectPlan.open(path.join(dir, 'p1'))
    const used = await load(plan, {
      p1CharacterId: '2',
      maxFiles: games.length + 2,
      sort: 'startAt:-1',
    })
    expect(used?.snapshot).toBe(SNAP.id)
    expect(plan.meta).toMatchObject({
      count: games.length,
      complete: false,
      prebuilt: { loaded: true, snapshot: SNAP.id },
    })
    // Reopened from disk, every record is there.
    const again = DirectPlan.open(path.join(dir, 'p1'))
    expect(again.entries().length).toBe(games.length * 48)
    const bodies: Record<string, unknown>[] = []
    await buildPlan(
      again,
      {
        filter: {
          p1CharacterId: '2',
          maxFiles: games.length + 2,
          sort: 'startAt:-1',
        },
      },
      async (body) => {
        bodies.push(body)
        // An older server: everything, including the full DB's games again.
        const page: LocationsPage = {
          snapshots: [SNAP, DELTA],
          games: [
            [
              games[0].id,
              '',
              'x',
              0,
              games[0].offset,
              games[0].length,
              games[0].header,
            ],
            [id(9), '', 'x', 1, 5000, 10, 4000],
          ],
          other: [id(10)],
          next: null,
        }
        return page
      },
      new AbortController().signal,
    )
    expect(bodies).toEqual([
      {
        p1CharacterId: '2',
        sort: 'startAt:-1',
        exceptSnapshot: SNAP.id,
        limit: 5000,
      },
    ])
    expect(again.meta).toMatchObject({
      count: games.length + 1,
      other: 1,
      complete: true,
    })
  })

  it('a stop half-way through loading starts the plan over', () => {
    const plan = DirectPlan.open(path.join(dir, 'p2'))
    plan.addPage(
      {
        snapshots: [SNAP],
        games: [[id(1), '', '', 0, 100, 10, 50]],
        other: [],
        next: null,
      },
      {
        cursor: null,
        complete: false,
        prebuilt: { snapshot: SNAP.id, file: 'f', loaded: false },
      },
    )
    plan.reset()
    const back = DirectPlan.open(path.join(dir, 'p2'))
    expect(back.meta).toMatchObject({ count: 0, complete: false })
    expect(back.meta.prebuilt).toBeUndefined()
    expect(back.entries().length).toBe(0)
  })

  it('nothing (list the usual way) on a bad checksum, another snapshot or no match', async () => {
    publish({ sha: '0'.repeat(64) })
    expect(
      await load(DirectPlan.open(path.join(dir, 'p3')), { p1CharacterId: '2' }),
    ).toBeNull()
    publish({ snapshot: 'archive/lunar_db_full.zip@other' })
    expect(
      await load(DirectPlan.open(path.join(dir, 'p4')), { p1CharacterId: '2' }),
    ).toBeNull()
    publish()
    expect(
      await load(DirectPlan.open(path.join(dir, 'p5')), { p1CharacterId: '9' }),
    ).toBeNull()
    files.delete('/v1/manifest.json')
    _resetManifestCache()
    const plan = DirectPlan.open(path.join(dir, 'p6'))
    expect(await load(plan, { p1CharacterId: '2' })).toBeNull()
    expect(plan.meta.count).toBe(0)
  }, 30_000) // builds and compresses 45,000 rows several times: slow on a busy CI runner
})
