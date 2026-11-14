/**
 * @jest-environment node
 *
 * Deleting from a tray (main/removeRows.ts, run by DbWorker):
 *  - a filter step's tray removes those results and what the later steps made
 *    from them, nothing else (no game, no other result);
 *  - the Replays tray removes the games, every row made from them in every
 *    step, also in another project (My Replays), by path;
 * and each step's cached count follows, so the tray's totals stay true.
 * On Node's own SQLite (node:sqlite): better-sqlite3 is built for Electron's ABI.
 */
import type Database from 'better-sqlite3'
import {
  removeGamesByIds,
  removeGamesByPaths,
  removeResultsCascade,
} from '../main/removeRows'

type SqliteDb = {
  exec: (_sql: string) => void
  prepare: (_sql: string) => {
    all: (..._a: unknown[]) => unknown[]
    get: (..._a: unknown[]) => unknown
    run: (..._a: unknown[]) => { changes: number | bigint }
  }
}
// eslint-disable-next-line global-require
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (_path: string) => SqliteDb
}

const GAMES = 20
// Replays (game filter) -> Combos (parser: 2 per game) -> Sort -> Long combos
// (keeps every other combo, as the filter worker writes it: _sourceId = input row).
const steps = [
  { id: 'filter_0', type: 'files' },
  { id: 'combos', type: 'slpParser' },
  { id: 'sorted', type: 'sort' },
  { id: 'long', type: 'comboFilter' },
]

function project() {
  const raw = new DatabaseSync(':memory:')
  raw.exec(`
    CREATE TABLE metadata (name TEXT, path TEXT, createdAt INTEGER, extra TEXT);
    CREATE TABLE files (id INTEGER PRIMARY KEY, path TEXT);
  `)
  for (const s of steps)
    raw.exec(`CREATE TABLE ${s.id} (id INTEGER PRIMARY KEY, JSON TEXT)`)
  const ins = (t: string, json: object) =>
    Number(
      (
        raw
          .prepare(`INSERT INTO ${t} (JSON) VALUES (?)`)
          .run(JSON.stringify(json)) as unknown as {
          lastInsertRowid: number | bigint
        }
      ).lastInsertRowid,
    )
  for (let g = 1; g <= GAMES; g += 1) {
    const path = `/r/${g}.slp`
    raw.prepare('INSERT INTO files (id, path) VALUES (?, ?)').run(g, path)
    const gameRow = ins('filter_0', { id: g, path, _sourceId: g })
    for (const k of [0, 1])
      ins('combos', {
        path,
        startFrame: 100 * k,
        endFrame: 100 * k + 50 + g,
        _sourceId: gameRow,
      })
  }
  // Sort copies the JSON verbatim, in another order.
  raw.exec(
    "INSERT INTO sorted (JSON) SELECT JSON FROM combos ORDER BY JSON_EXTRACT(JSON, '$.endFrame') DESC",
  )
  const sortedRows = raw
    .prepare('SELECT id, JSON FROM sorted ORDER BY id')
    .all() as { id: number; JSON: string }[]
  sortedRows.forEach((r, i) => {
    if (i % 2 === 0) ins('long', { ...JSON.parse(r.JSON), _sourceId: r.id })
  })
  const count = (t: string) =>
    (raw.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n
  const cachedCounts = Object.fromEntries(steps.map((s) => [s.id, count(s.id)]))
  raw
    .prepare('INSERT INTO metadata VALUES (?, ?, ?, ?)')
    .run(
      'p',
      '/p.lunar',
      0,
      JSON.stringify({ filters: steps, cachedFileCount: GAMES, cachedCounts }),
    )
  const db = {
    exec: (sql: string) => raw.exec(sql),
    prepare: (sql: string) => raw.prepare(sql),
  } as unknown as Database.Database
  const cached = () => {
    const e = JSON.parse(
      (raw.prepare('SELECT extra FROM metadata').get() as { extra: string })
        .extra,
    )
    return { files: e.cachedFileCount, ...e.cachedCounts }
  }
  const rows = (t: string) =>
    (raw.prepare(`SELECT JSON FROM ${t}`).all() as { JSON: string }[]).map(
      (r) => JSON.parse(r.JSON),
    )
  const counts = (): Record<string, number> => ({
    files: count('files'),
    ...Object.fromEntries(steps.map((s) => [s.id, count(s.id)])),
  })
  return { raw, db, cached, rows, counts, count }
}

const downstreamOf = (id: string) =>
  steps.slice(steps.findIndex((s) => s.id === id) + 1)

describe("deleting from a filter step's tray", () => {
  it('removes those results and what later steps made from them, nothing else', () => {
    const p = project()
    const before = p.counts()
    expect(before).toEqual({
      files: 20,
      filter_0: 20,
      combos: 40,
      sorted: 40,
      long: 20,
    })
    // Every combo of game 3 and game 7.
    const ids = (
      p.raw
        .prepare(
          "SELECT id FROM combos WHERE JSON_EXTRACT(JSON, '$.path') IN ('/r/3.slp', '/r/7.slp')",
        )
        .all() as { id: number }[]
    ).map((r) => r.id)
    const longBefore = p
      .rows('long')
      .filter((r) => r.path === '/r/3.slp' || r.path === '/r/7.slp').length

    const removed = removeResultsCascade(
      p.db,
      'combos',
      ids,
      downstreamOf('combos'),
    )
    expect(removed).toEqual({ combos: 4, sorted: 4, long: longBefore })
    const after = p.counts()
    expect(after).toEqual({
      files: 20,
      filter_0: 20,
      combos: 36,
      sorted: 36,
      long: 20 - longBefore,
    })
    // Nothing of another game went; nothing of these games is left downstream.
    for (const t of ['combos', 'sorted', 'long'])
      expect(
        p.rows(t).some((r) => r.path === '/r/3.slp' || r.path === '/r/7.slp'),
      ).toBe(false)
    // The cached counts the tray shows follow.
    expect(p.cached()).toEqual(after)
  })

  it('one result: only it and its copies downstream', () => {
    const p = project()
    const one = p.raw
      .prepare('SELECT id, JSON FROM combos ORDER BY id LIMIT 1')
      .get() as { id: number; JSON: string }
    const removed = removeResultsCascade(
      p.db,
      'combos',
      [one.id],
      downstreamOf('combos'),
    )
    expect(removed.combos).toBe(1)
    expect(removed.sorted).toBe(1)
    expect(removed.long).toBeLessThanOrEqual(1)
    expect(p.count('files')).toBe(20)
    const { path, startFrame } = JSON.parse(one.JSON)
    expect(p.rows('combos').filter((r) => r.path === path)).toHaveLength(1)
    expect(
      p
        .rows('sorted')
        .some((r) => r.path === path && r.startFrame === startFrame),
    ).toBe(false)
  })

  it('a row without _sourceId downstream is matched by its game and frames', () => {
    const p = project()
    const one = JSON.parse(
      (
        p.raw.prepare('SELECT JSON FROM sorted ORDER BY id LIMIT 1').get() as {
          JSON: string
        }
      ).JSON,
    )
    p.raw.exec('DELETE FROM long')
    const { _sourceId: _drop, ...noSource } = one
    p.raw
      .prepare('INSERT INTO long (JSON) VALUES (?)')
      .run(JSON.stringify(noSource))
    p.raw
      .prepare('INSERT INTO long (JSON) VALUES (?)')
      .run(JSON.stringify({ ...noSource, startFrame: 9999 }))
    const sortedId = (
      p.raw.prepare('SELECT id FROM sorted ORDER BY id LIMIT 1').get() as {
        id: number
      }
    ).id
    const removed = removeResultsCascade(
      p.db,
      'sorted',
      [sortedId],
      [{ id: 'long', type: 'comboFilter' }],
    )
    expect(removed).toEqual({ sorted: 1, long: 1 })
    expect(p.rows('long')).toEqual([{ ...noSource, startFrame: 9999 }])
  })

  it('the last step: only its own rows', () => {
    const p = project()
    const ids = (
      p.raw.prepare('SELECT id FROM long').all() as { id: number }[]
    ).map((r) => r.id)
    expect(removeResultsCascade(p.db, 'long', ids, [])).toEqual({ long: 20 })
    expect(p.counts()).toEqual({
      files: 20,
      filter_0: 20,
      combos: 40,
      sorted: 40,
      long: 0,
    })
    expect(p.cached().long).toBe(0)
  })
})

describe('deleting from the Replays tray', () => {
  it('removes the games and every row made from them in every step', () => {
    const p = project()
    const paths = removeGamesByIds(
      p.db,
      [2, 5, 11],
      steps.map((s) => s.id),
    )
    expect(paths.sort()).toEqual(['/r/11.slp', '/r/2.slp', '/r/5.slp'])
    const gone = new Set(paths)
    for (const s of steps)
      expect(p.rows(s.id).some((r) => gone.has(r.path))).toBe(false)
    const after = p.counts()
    expect(after.files).toBe(17)
    expect(after.filter_0).toBe(17)
    expect(after.combos).toBe(34)
    expect(after.sorted).toBe(34)
    expect(p.cached()).toEqual(after)
  })

  it('Select All: every step empty, every count 0', () => {
    const p = project()
    const all = Array.from({ length: GAMES }, (_, i) => i + 1)
    removeGamesByIds(
      p.db,
      all,
      steps.map((s) => s.id),
    )
    const zero = { files: 0, filter_0: 0, combos: 0, sorted: 0, long: 0 }
    expect(p.counts()).toEqual(zero)
    expect(p.cached()).toEqual(zero)
  })

  it('removes them from another project (My Replays) by path', () => {
    const p = project()
    const games = removeGamesByPaths(p.db, [
      '/r/1.slp',
      '/r/4.slp',
      '/x/no.slp',
    ])
    expect(games).toBe(2)
    const after = p.counts()
    expect(after.files).toBe(18)
    expect(after.combos).toBe(36)
    expect(p.cached()).toEqual(after)
  })
})
