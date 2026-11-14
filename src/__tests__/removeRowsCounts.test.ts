/**
 * @jest-environment node
 *
 * Removing rows through DbWorker keeps the project's cached counts true, so the
 * totals getMetadata hands the tray match the tables (main/removeRows.ts).
 *
 * The bug: the tray's total comes from metadata.extra (cachedFileCount /
 * cachedCounts) and DbWorker's deletes never touched it, so Select All + Delete
 * on 300 games left "0 / 300 games" and a grid of empty placeholder tiles, for
 * good (the stale count was saved in the project).
 *
 * On Node's own SQLite (node:sqlite): better-sqlite3 is built for Electron's ABI.
 */
import type Database from 'better-sqlite3'

// node:sqlite, typed by hand: this project's @types/node predates it.
type SqliteStmt = {
  all: (..._a: unknown[]) => unknown[]
  get: (..._a: unknown[]) => unknown
  run: (..._a: unknown[]) => { changes: number | bigint }
}
type SqliteDb = {
  exec: (_sql: string) => void
  prepare: (_sql: string) => SqliteStmt
}
// eslint-disable-next-line global-require
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (_path: string) => SqliteDb
}

let mockDb: Database.Database | null = null
let onMessage: ((_msg: any) => void) | null = null
const posted: any[] = []

jest.mock('worker_threads', () => ({
  parentPort: {
    on: (_event: string, fn: (_msg: any) => void) => {
      onMessage = fn
    },
    postMessage: (msg: any) => posted.push(msg),
  },
}))
jest.mock('better-sqlite3', () => jest.fn())
jest.mock('../main/dbConnection', () => ({
  getDb: () => mockDb,
  closeDb: () => {},
}))
jest.mock('../main/db', () => ({ WORKER_SYNC_FNS: {} }))
jest.mock('../main/replayLibrary', () => ({
  LIBRARY_FNS: {},
  closeLibraries: () => {},
}))

// eslint-disable-next-line import/first
import '../main/DbWorker'

let nextId = 1
function send(method: string, args: Record<string, unknown> = {}) {
  posted.length = 0
  onMessage!({ id: nextId++, dbPath: '/p.lunar', method, ...args })
  const res = posted[0]
  if (res?.type === 'error') throw new Error(res.error)
  return res?.data
}

const GAMES = 300
const filters = [
  { id: 'filter_0', type: 'files', label: 'Replays', isProcessed: true },
  { id: 'filter_1', type: 'slpParser', label: 'Combos', isProcessed: true },
]

/** A project with 300 games, a processed Replays step and a combo step. */
function project(cache: { files?: number; counts?: Record<string, number> }) {
  // DbWorker keeps its connection per path: let go of the last test's.
  if (mockDb) send('closeDb')
  const raw = new DatabaseSync(':memory:')
  raw.exec(`
    CREATE TABLE metadata (name TEXT, path TEXT, createdAt INTEGER, extra TEXT);
    CREATE TABLE files (id INTEGER PRIMARY KEY, path TEXT);
    CREATE TABLE filter_0 (id INTEGER PRIMARY KEY, JSON TEXT);
    CREATE TABLE filter_1 (id INTEGER PRIMARY KEY, JSON TEXT);
  `)
  const extra: any = { filters }
  if (cache.files !== undefined) extra.cachedFileCount = cache.files
  if (cache.counts) extra.cachedCounts = cache.counts
  raw
    .prepare('INSERT INTO metadata VALUES (?, ?, ?, ?)')
    .run('p', '/p.lunar', 0, JSON.stringify(extra))
  for (let i = 1; i <= GAMES; i += 1) {
    const path = `/r/${i}.slp`
    raw.prepare('INSERT INTO files (id, path) VALUES (?, ?)').run(i, path)
    raw
      .prepare('INSERT INTO filter_0 (id, JSON) VALUES (?, ?)')
      .run(i, JSON.stringify({ id: i, path }))
    // Two combos per game.
    for (const k of [0, 1])
      raw
        .prepare('INSERT INTO filter_1 (id, JSON) VALUES (?, ?)')
        .run(i * 2 - k, JSON.stringify({ path }))
  }
  mockDb = {
    exec: (sql: string) => raw.exec(sql),
    prepare: (sql: string) => raw.prepare(sql),
    pragma: (sql: string) => raw.prepare(`PRAGMA ${sql}`).all(),
  } as unknown as Database.Database
  return raw
}

const count = (raw: SqliteDb, table: string) =>
  (raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
const ids = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i)

/** The totals the tray is given: files and each filter's results. */
function totals() {
  const meta = send('getMetadata')
  return {
    files: meta.files,
    ...Object.fromEntries(meta.filters.map((f: any) => [f.id, f.results])),
  }
}

describe('removing rows keeps the cached counts true', () => {
  it('removing every game (Replays step, Select All + Delete) leaves 0 games', () => {
    const raw = project({
      files: GAMES,
      counts: { filter_0: GAMES, filter_1: GAMES * 2 },
    })
    // ClipManager.removeGames: 5,000-row chunks, then every filter by path.
    send('deleteFiles', { fileIds: ids(1, GAMES) })
    const paths = ids(1, GAMES).map((i) => `/r/${i}.slp`)
    for (const f of filters)
      send('deleteRowsByFilePaths', { tableId: f.id, filePaths: paths })

    expect(count(raw, 'files')).toBe(0)
    expect(totals()).toEqual({ files: 0, filter_0: 0, filter_1: 0 })
  })

  it('removing some games takes exactly those off', () => {
    project({ files: GAMES, counts: { filter_0: GAMES, filter_1: GAMES * 2 } })
    send('deleteFiles', { fileIds: ids(1, 48) })
    const paths = ids(1, 48).map((i) => `/r/${i}.slp`)
    for (const f of filters)
      send('deleteRowsByFilePaths', { tableId: f.id, filePaths: paths })
    expect(totals()).toEqual({
      files: GAMES - 48,
      filter_0: GAMES - 48,
      filter_1: (GAMES - 48) * 2,
    })
  })

  it('removing rows of a processed step lowers that step only', () => {
    project({ files: GAMES, counts: { filter_0: GAMES, filter_1: GAMES * 2 } })
    send('deleteRows', { tableId: 'filter_1', rowIds: ids(1, GAMES * 2) })
    expect(totals()).toEqual({ files: GAMES, filter_0: GAMES, filter_1: 0 })
  })

  it('ids that are already gone take nothing off', () => {
    project({ files: GAMES, counts: { filter_1: GAMES * 2 } })
    send('deleteFiles', { fileIds: ids(1, 10) })
    send('deleteFiles', { fileIds: ids(1, 10) })
    expect(totals().files).toBe(GAMES - 10)
  })

  it('a count that was never cached stays unknown (the tray recounts it)', () => {
    project({})
    send('deleteFiles', { fileIds: ids(1, 10) })
    send('deleteRows', { tableId: 'filter_1', rowIds: ids(1, 4) })
    expect(totals()).toEqual({ files: null, filter_0: null, filter_1: null })
  })
})
