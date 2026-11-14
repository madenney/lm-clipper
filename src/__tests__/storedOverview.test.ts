/**
 * @jest-environment node
 *
 * The tray overview's stored columns (main/overview.ts RESULTS_TABLE_COLUMNS) on a
 * real SQLite table. better-sqlite3 is built for Electron's ABI, so this runs on
 * Node's own SQLite (node:sqlite) behind a small better-sqlite3-shaped adapter;
 * scripts/worker-check/overview.js runs the same reader on better-sqlite3.
 */
import type Database from 'better-sqlite3'
import {
  OVERVIEW_NONE,
  OVERVIEW_STAGE_NONE,
  RESULTS_TABLE_COLUMNS,
  TONE_HOT,
  TONE_KILL,
  TONE_NONE,
  hasStoredOverview,
  hasStoredTone,
  readOverviewChunk,
  readOverviewSignature,
  type OverviewCursor,
} from '../main/overview'

// node:sqlite, typed by hand: this project's @types/node predates it.
type SqliteStmt = {
  all: (..._a: unknown[]) => unknown[]
  get: (..._a: unknown[]) => unknown
  run: (..._a: unknown[]) => unknown
  setReturnArrays: (_on: boolean) => void
}
type SqliteDb = {
  exec: (_sql: string) => void
  prepare: (_sql: string) => SqliteStmt
}
// eslint-disable-next-line global-require
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (_path: string) => SqliteDb
}

/** Every SQL string prepared through the adapter, newest last. */
let prepared: string[] = []

/** The parts of better-sqlite3 overview.ts and db.ts use, on node:sqlite. */
function adapt(db: SqliteDb) {
  const prepare = (sql: string) => {
    prepared.push(sql)
    const st = db.prepare(sql)
    // better-sqlite3 ignores named parameters the SQL doesn't use; node:sqlite throws.
    const names = new Set(Array.from(sql.matchAll(/@(\w+)/g), (m) => m[1]))
    const args = (a: unknown[]) =>
      a.length === 1 && a[0] && typeof a[0] === 'object'
        ? [
            Object.fromEntries(
              Object.entries(a[0] as Record<string, unknown>).filter(([k]) =>
                names.has(k),
              ),
            ),
          ]
        : a
    const wrap = {
      raw: () => {
        st.setReturnArrays(true)
        return wrap
      },
      all: (...a: unknown[]) => st.all(...args(a)),
      get: (...a: unknown[]) => st.get(...args(a)),
      run: (...a: unknown[]) => st.run(...args(a)),
    }
    return wrap
  }
  return {
    prepare,
    exec: (sql: string) => db.exec(sql),
  } as unknown as Database.Database
}

let mockDb: Database.Database | null = null
jest.mock('../main/dbConnection', () => ({
  getDb: () => mockDb,
  setOnCloseCallback: () => {},
}))

const player = (i: number, c: unknown) => ({ playerIndex: i, characterId: c })
const clip = (i: number) => ({
  path: `/x/${i}.slp`,
  stage: [2, 3, 8, 28, 31, 32][i % 6],
  comboer: player(0, i % 26),
  comboee: player(1, (i * 7) % 26),
})
/** Rows whose fields aren't plain small integers: both readers must agree. */
const ODD = [
  { path: '/x/none.slp' },
  { stage: '8', comboer: player(0, '20'), comboee: player(1, 2.0) },
  { stage: 2.5, comboer: player(0, -1), comboee: player(1, 300) },
  { stage: 255, comboer: player(0, null), comboee: player(1, 'fox') },
  // Game rows (Game filter, Sort over games): characters from players[].
  { stage: 31, players: [player(0, 9), player(1, 20)] },
  // A combo row missing one side's character falls back to players[].
  {
    stage: 3,
    comboer: { playerIndex: 0 },
    players: [player(0, 4), player(1, 5)],
  },
]

function fresh() {
  const raw = new DatabaseSync(':memory:')
  const db = adapt(raw)
  db.exec(
    'CREATE TABLE "legacy" (id INTEGER PRIMARY KEY AUTOINCREMENT, JSON TEXT, sort_order INTEGER DEFAULT NULL)',
  )
  db.exec(`CREATE TABLE "stored" (${RESULTS_TABLE_COLUMNS})`)
  return { raw, db }
}

function fill(db: Database.Database, t: string, rows: object[]) {
  const ins = db.prepare(`INSERT INTO "${t}" (JSON) VALUES (?)`)
  for (const r of rows) ins.run(JSON.stringify(r))
}

function readAll(db: Database.Database, t: string, limit: number) {
  const ids: number[] = []
  const bytes: number[] = []
  let cursor: OverviewCursor = null
  let chunks = 0
  do {
    const c = readOverviewChunk(db, t, cursor, limit)
    ids.push(...c.ids)
    bytes.push(...c.packed)
    cursor = c.next
    chunks += 1
  } while (cursor)
  return { ids, bytes, chunks }
}

beforeEach(() => {
  prepared = []
})

describe('stored overview columns', () => {
  it('give the same overview as json_extract, odd values included', () => {
    const { db } = fresh()
    const rows = [...Array.from({ length: 40 }, (_, i) => clip(i + 1)), ...ODD]
    fill(db, 'legacy', rows)
    fill(db, 'stored', rows)
    const a = readAll(db, 'legacy', 7)
    const b = readAll(db, 'stored', 7)
    expect(b.ids).toEqual(a.ids)
    expect(b.bytes).toEqual(a.bytes)
    expect(b.chunks).toBe(7)
    // The odd rows, as the overview sees them.
    expect(b.bytes.slice(40 * 3)).toEqual([
      ...[OVERVIEW_STAGE_NONE, OVERVIEW_NONE, OVERVIEW_NONE],
      ...[8, 20, 2],
      ...[OVERVIEW_STAGE_NONE, OVERVIEW_NONE, OVERVIEW_NONE],
      ...[OVERVIEW_STAGE_NONE, OVERVIEW_NONE, OVERVIEW_NONE],
      ...[31, 9, 20],
      ...[3, 4, 5],
    ])
  })

  it('are read in place of the JSON on new tables only', () => {
    const { db } = fresh()
    fill(db, 'legacy', [clip(1)])
    fill(db, 'stored', [clip(1)])
    expect(hasStoredOverview(db, 'stored')).toBe(true)
    expect(hasStoredOverview(db, 'legacy')).toBe(false)
    expect(hasStoredOverview(db, 'files')).toBe(false)

    prepared = []
    readOverviewChunk(db, 'stored', null, 10)
    const storedSql = prepared.find((s) => s.includes('FROM "stored"'))
    expect(storedSql).toContain('ov_stage')
    expect(storedSql).not.toContain('json_extract')

    prepared = []
    readOverviewChunk(db, 'legacy', null, 10)
    expect(prepared.find((s) => s.includes('FROM "legacy"'))).toContain(
      'json_extract',
    )
  })

  it('are filled by every way rows are written', () => {
    const { db } = fresh()
    fill(db, 'legacy', [clip(1), clip(2), clip(3)])
    // Sort / random sample write with INSERT ... SELECT JSON.
    db.prepare(
      'INSERT INTO "stored" (JSON) SELECT JSON FROM "legacy" ORDER BY id DESC',
    ).run()
    // Manual order (Worker.ts keepOrder) writes JSON and sort_order.
    db.prepare('INSERT INTO "stored" (JSON, sort_order) VALUES (?, ?)').run(
      JSON.stringify(clip(4)),
      0,
    )
    const bytesOf = (i: number) => [
      clip(i).stage,
      clip(i).comboer.characterId,
      clip(i).comboee.characterId,
    ]
    expect(readAll(db, 'stored', 10).bytes).toEqual(
      [3, 2, 1, 4].flatMap(bytesOf),
    )
    // A rewrite of the JSON (the missing-replay path remap, a json_set) updates them.
    db.prepare(
      `UPDATE "stored" SET JSON = json_set(JSON, '$.stage', 32) WHERE id = 1`,
    ).run()
    expect(readAll(db, 'stored', 10).bytes.slice(0, 3)).toEqual([
      32,
      ...bytesOf(3).slice(1),
    ])
  })

  it('custom-sorted tables: tray order across chunks, seeking the sort index', () => {
    const { raw, db } = fresh()
    fill(
      db,
      'stored',
      Array.from({ length: 30 }, (_, i) => clip(i + 1)),
    )
    db.exec(
      'CREATE INDEX "idx_stored_sortorder" ON "stored"(COALESCE(sort_order, id), id)',
    )
    // Ties on the sort key (equal sort_order) must still page by id.
    const set = db.prepare('UPDATE "stored" SET sort_order = ? WHERE id = ?')
    for (const [o, id] of [
      [5, 20],
      [5, 21],
      [5, 3],
      [0, 30],
      [0, 29],
    ])
      set.run(o, id)
    const want = (
      raw
        .prepare(
          'SELECT id FROM "stored" ORDER BY COALESCE(sort_order, id), id',
        )
        .all() as { id: number }[]
    ).map((r) => r.id)
    prepared = []
    const got = readAll(db, 'stored', 4)
    expect(got.ids).toEqual(want)

    // A follow-up chunk seeks to the cursor instead of scanning from the start.
    const sql = prepared.find((s) => s.includes('@key'))
    expect(sql).toBeDefined()
    const plan = (
      raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all({ key: 5, id: 3, n: 4 }) as {
        detail: string
      }[]
    )
      .map((r) => r.detail)
      .join(' | ')
    expect(plan).toMatch(/SEARCH .*idx_stored_sortorder/)
  })

  it('keep the disk-cache fingerprint working', () => {
    const { db } = fresh()
    fill(db, 'stored', [clip(1), clip(2)])
    const sig = readOverviewSignature(db, 'stored')
    expect(readOverviewSignature(db, 'stored')).toBe(sig)
    fill(db, 'stored', [clip(3)])
    expect(readOverviewSignature(db, 'stored')).not.toBe(sig)
  })
})

/** Rows of every kind, with the tone the card gives them (cardSummary.ts). */
const move = { moveId: 13, frame: 10, damage: 12 }
const combo = (c: object) => ({
  ...clip(1),
  combo: { startPercent: 0, endPercent: 40, moves: [move], ...c },
})
const eg = (extra: object, metrics: object = {}) => ({
  ...clip(2),
  edgeguardMetrics: {
    hits: 2,
    stageTouches: 0,
    recoveryAttempts: 1,
    ...metrics,
  },
  ...extra,
})
const TONED: [object, number][] = [
  [combo({ didKill: true }), TONE_KILL],
  [combo({ didKill: true, earlyQuit: true }), TONE_NONE],
  [combo({ didKill: false }), TONE_NONE],
  [combo({}), TONE_NONE],
  [eg({ edgeguardScore: 45 }), TONE_HOT],
  [eg({ edgeguardScore: 44.9 }), TONE_NONE],
  [eg({ edgeguardScore: 80 }, { score: 10 }), TONE_HOT],
  [eg({}, { score: 51.5 }), TONE_HOT],
  [eg({}, { score: 30 }), TONE_NONE],
  [eg({}), TONE_NONE],
  [eg({ edgeguardScore: '90' }, { score: 'x' }), TONE_NONE],
  [{ ...clip(3), highlightMetrics: { score: 99, flavors: [] } }, TONE_NONE],
  [
    { ...clip(4), pressureMetrics: { score: 50, endedInKill: true } },
    TONE_KILL,
  ],
  [
    { ...clip(5), pressureMetrics: { score: 50, endedInKill: false } },
    TONE_NONE,
  ],
  [
    { stage: 31, players: [player(0, 9), player(1, 20)], lastFrame: 9000 },
    TONE_NONE,
  ],
  [{ ...clip(6), phantomMetrics: { damage: 3, victimPercent: 40 } }, TONE_NONE],
]
const toneOf = (b: number) => b >> 6
const stageOf = (b: number) => b & 63

describe('the tone (kill / standout ring) in the stage byte', () => {
  it('follows the card: stored column, json fallback and cardSummary agree', () => {
    // eslint-disable-next-line global-require
    const { summarizeClip } = require('../renderer/components/Clip/cardSummary')
    const want = TONED.map(([, t]) => t)
    const asCard = TONED.map(([row]) => {
      const tone = summarizeClip(row).tone as string
      return tone === 'kill' ? TONE_KILL : tone === 'hot' ? TONE_HOT : TONE_NONE
    })
    expect(asCard).toEqual(want)

    const { db } = fresh()
    // A table from 2026-10-11..15: the stored characters, no stored tone.
    db.exec(
      `CREATE TABLE "middle" (${RESULTS_TABLE_COLUMNS.replace(/ov_tone GENERATED[\s\S]*?END\) STORED,/, '')})`,
    )
    expect(hasStoredOverview(db, 'middle')).toBe(true)
    expect(hasStoredTone(db, 'middle')).toBe(false)
    expect(hasStoredTone(db, 'stored')).toBe(true)
    const rows = TONED.map(([row]) => row)
    for (const t of ['legacy', 'middle', 'stored']) {
      fill(db, t, rows)
      const { bytes } = readAll(db, t, 5)
      const firsts = bytes.filter((_, i) => i % 3 === 0)
      expect(firsts.map(toneOf)).toEqual(want)
      expect(firsts.map(stageOf)).toEqual(
        rows.map((r) => (r as { stage: number }).stage),
      )
    }
    prepared = []
    readOverviewChunk(db, 'stored', null, 10)
    expect(prepared.find((q) => q.includes('FROM "stored"'))).not.toContain(
      'json_',
    )
  })

  it('a stage the 6 bits cannot hold reads as no stage, its tone kept', () => {
    const { db } = fresh()
    fill(db, 'stored', [
      { ...combo({ didKill: true }), stage: 63 },
      { ...combo({ didKill: true }), stage: 200 },
      { ...combo({ didKill: true }), stage: 62 },
    ])
    const firsts = readAll(db, 'stored', 10).bytes.filter((_, i) => i % 3 === 0)
    expect(firsts.map(stageOf)).toEqual([
      OVERVIEW_STAGE_NONE,
      OVERVIEW_STAGE_NONE,
      62,
    ])
    expect(firsts.map(toneOf)).toEqual([TONE_KILL, TONE_KILL, TONE_KILL])
  })
})

describe('results tables are created with the stored columns', () => {
  it('createFilter (new steps and every fresh run)', async () => {
    const { db } = fresh()
    mockDb = db
    const { createFilter } = await import('../main/db')
    createFilter('/proj/a.lunar', 'filter_new')
    expect(hasStoredOverview(db, 'filter_new')).toBe(true)
    // An existing (older) table is left as it is: read with json_extract.
    createFilter('/proj/a.lunar', 'legacy')
    expect(hasStoredOverview(db, 'legacy')).toBe(false)
    mockDb = null
  })
})
