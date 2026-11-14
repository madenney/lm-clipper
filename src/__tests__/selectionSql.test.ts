/**
 * @jest-environment node
 *
 * A tray selection turned into rows in SQL (main/selectionSql.ts), as delete,
 * record, play and the selection's duration use it, plus db.ts getItemsByIds past
 * SQLite's bound-value limit. On Node's own SQLite (node:sqlite): better-sqlite3
 * is built for Electron's ABI. Checked against brute force over the same rows.
 */
import type Database from 'better-sqlite3'
import { Selection } from '../lib/selection'
import {
  ID_BATCH,
  durationExpr,
  forEachIdBatch,
  selectionFrames,
  selectionIds,
} from '../main/selectionSql'
import { RESULTS_TABLE_COLUMNS } from '../main/overview'
import { getItemsByIds } from '../main/db'

// node:sqlite, typed by hand: this project's @types/node predates it.
type SqliteDb = {
  exec: (_sql: string) => void
  prepare: (_sql: string) => Database.Statement
}
// eslint-disable-next-line global-require
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (_path: string) => SqliteDb
}

/** Every SQL string prepared, for counting statements. */
let prepared: string[] = []
const adapt = (raw: SqliteDb) =>
  ({
    exec: (sql: string) => raw.exec(sql),
    prepare: (sql: string) => {
      prepared.push(sql)
      return raw.prepare(sql)
    },
  }) as unknown as Database.Database

let mockDb: Database.Database | null = null
jest.mock('../main/dbConnection', () => ({
  getDb: () => mockDb,
  setOnCloseCallback: () => {},
}))

const N = 4000
const ORDER_SORTED = 'COALESCE(sort_order, id), id'

/** A results table of N clips (lengths vary), with gaps in its ids. */
function setup() {
  const db = adapt(new DatabaseSync(':memory:'))
  db.exec(`CREATE TABLE "r" (${RESULTS_TABLE_COLUMNS})`)
  const ins = db.prepare(`INSERT INTO "r" (JSON) VALUES (?)`)
  for (let i = 0; i < N; i += 1)
    ins.run(
      JSON.stringify(
        i % 9 === 0
          ? { path: `/g/${i}`, lastFrame: 1000 + i } // a whole game
          : { path: `/c/${i}`, startFrame: i, endFrame: i + (i % 50) },
      ),
    )
  db.exec('DELETE FROM "r" WHERE id % 97 = 0') // removed rows
  // A custom sort: reversed in blocks of 10, with ties (sort_order shared).
  db.exec(
    'CREATE TABLE "s" AS SELECT id, JSON, ((4000 - id) / 10) AS sort_order FROM "r"',
  )
  return db
}

const rows = (db: Database.Database, t: string) =>
  db.prepare(`SELECT id, JSON, sort_order FROM "${t}"`).all() as {
    id: number
    JSON: string
    sort_order: number | null
  }[]
const framesOf = (json: string) => {
  const c = JSON.parse(json)
  const start = c.startFrame ?? 0
  const end = (c.endFrame ?? 0) > 0 ? c.endFrame : (c.lastFrame ?? 0)
  return Math.max(0, end - start)
}

const rng = (seed: number) => () => {
  seed = (seed * 1103515245 + 12345) % 2 ** 31
  return seed / 2 ** 31
}

/** Selections of every shape: scattered, runs, Select All with rows left out. */
function selections() {
  const r = rng(3)
  const pick = (k: number) =>
    Array.from({ length: k }, () => 1 + Math.floor(r() * N))
  const run = (lo: number, hi: number) =>
    Array.from({ length: hi - lo + 1 }, (_, i) => lo + i)
  return [
    Selection.none(),
    Selection.of([5]),
    Selection.of(pick(30)),
    Selection.of(pick(3000)),
    Selection.of([...run(100, 900), ...pick(40), ...run(2000, 2016)]),
    Selection.of([97, 194, 1, 2]), // two removed rows
    Selection.everything(N),
    Selection.everything(N).with(pick(25), false),
    Selection.everything(N).with(run(1, 3000), false),
  ]
}

describe('forEachIdBatch', () => {
  it('covers every id once, ascending, within the bound-value limit', () => {
    const ids = [
      ...Array.from({ length: 12000 }, (_, i) => i * 2 + 1), // scattered
      ...Array.from({ length: 500 }, (_, i) => 50000 + i), // a run
      60000,
    ]
    const sel = Selection.of(ids)
    const seen: number[] = []
    let last = -1
    forEachIdBatch(sel.bits, (where, params) => {
      expect(params.length).toBeLessThanOrEqual(ID_BATCH)
      const got = where.startsWith('id BETWEEN')
        ? Array.from(
            { length: params[1] - params[0] + 1 },
            (_, i) => params[0] + i,
          )
        : params
      expect(got[0]).toBeGreaterThan(last)
      last = got[got.length - 1]
      seen.push(...got)
    })
    expect(seen).toEqual(ids)
  })
})

describe('selectionIds', () => {
  it('gives the selected rows in display order, by id or a custom sort', () => {
    const db = setup()
    for (const [table, orderBy] of [
      ['r', 'id'],
      ['s', ORDER_SORTED],
    ] as const) {
      const ordered = (
        db.prepare(`SELECT id FROM "${table}" ORDER BY ${orderBy}`).all() as {
          id: number
        }[]
      ).map((x) => x.id)
      for (const sel of selections()) {
        const want = ordered.filter((id) => sel.has(id))
        expect(Array.from(selectionIds(db, table, sel, orderBy))).toEqual(want)
        expect(Array.from(selectionIds(db, table, sel, orderBy, 7))).toEqual(
          want.slice(0, 7),
        )
      }
    }
  })

  it('looks rows up by id: a run is one statement, not a scan', () => {
    const db = setup()
    prepared = []
    selectionIds(
      db,
      'r',
      Selection.of(Array.from({ length: 3000 }, (_, i) => i + 1)),
      'id',
    )
    expect(prepared).toHaveLength(1)
    expect(prepared[0]).toMatch(/BETWEEN/)
  })
})

describe('selectionFrames', () => {
  it('adds up frames and rows like brute force (JSON and column tables)', () => {
    const db = setup()
    db.exec(
      'CREATE TABLE "files" (id INTEGER PRIMARY KEY, path TEXT, lastFrame INTEGER)',
    )
    db.exec(
      'INSERT INTO "files" (id, path, lastFrame) SELECT id, path, (id * 13) % 9000 FROM (SELECT id, json_extract(JSON, \'$.path\') AS path FROM "r")',
    )
    const all = rows(db, 'r')
    const fileFrames = new Map(
      (
        db.prepare('SELECT id, lastFrame FROM "files"').all() as {
          id: number
          lastFrame: number
        }[]
      ).map((f) => [f.id, f.lastFrame]),
    )
    const rCols = new Set(['id', 'JSON', 'sort_order'])
    const fCols = new Set(['id', 'path', 'lastFrame'])
    for (const sel of selections()) {
      const picked = all.filter((x) => sel.has(x.id))
      expect(selectionFrames(db, 'r', sel, rCols)).toEqual({
        frames: picked.reduce((a, x) => a + framesOf(x.JSON), 0),
        count: picked.length,
      })
      expect(selectionFrames(db, 'files', sel, fCols)).toEqual({
        frames: picked.reduce((a, x) => a + fileFrames.get(x.id)!, 0),
        count: picked.length,
      })
    }
  })

  it('has no length to add for a table without frames', () => {
    expect(durationExpr(new Set(['id', 'path']))).toBeNull()
    const db = setup()
    db.exec('CREATE TABLE "plain" (id INTEGER PRIMARY KEY, path TEXT)')
    db.exec(`INSERT INTO "plain" (id, path) VALUES (1, 'a'), (2, 'b')`)
    expect(
      selectionFrames(db, 'plain', Selection.everything(2), new Set(['id'])),
    ).toEqual({ frames: 0, count: 2 })
  })
})

describe('getItemsByIds', () => {
  it('reads more ids than one statement takes, in display order', () => {
    const db = setup()
    mockDb = db
    // 12k ids, given shuffled: three statements, one list in sort order.
    db.exec(
      'CREATE TABLE "big" (id INTEGER PRIMARY KEY, JSON TEXT, sort_order INTEGER)',
    )
    db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 12000)
      INSERT INTO "big" (id, JSON, sort_order) SELECT i, '{}', (i * 7919) % 12007 FROM n`)
    const r = rng(9)
    const ids = Array.from({ length: 12000 }, (_, i) => i + 1).sort(
      () => r() - 0.5,
    )
    prepared = []
    const got = getItemsByIds('x.lunar', 'big', ids) as {
      id: number
      sort_order: number
    }[]
    expect(prepared.filter((q) => /WHERE id IN/.test(q))).toHaveLength(3)
    expect(got).toHaveLength(12000)
    for (let i = 1; i < got.length; i += 1)
      expect(got[i].sort_order).toBeGreaterThan(got[i - 1].sort_order)
    mockDb = null
  })
})
