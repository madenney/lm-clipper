/**
 * The read lane's worker (readLane.ts): a read-only connection to the open project
 * for the tray's window reads, so they never queue behind DbWorker's writes and
 * long scans. WAL lets it read while the other connections write. The background
 * lane runs the same worker for slow reads: a table's or a selection's length and
 * the overview chunks that warm the disk cache.
 */
import { parentPort, workerData } from 'worker_threads'
import Database from 'better-sqlite3'
import { readWindow, WindowCache } from './rowSeek'
import { durationExpr, selectionFrames } from './selectionSql'
import { readOverviewChunk, readOverviewSignature } from './overview'
import type { OverviewCursor } from './overview'
import { Selection, type SelectionWire } from '../lib/selection'

type Read = { id: number; dbPath: string; slot: number | null; gen: number }
type ReadRequest =
  | (Read & {
      method: 'readWindow'
      tableId: string
      offset: number
      limit: number
    })
  | (Read & { method: 'tableDuration'; tableId: string })
  | (Read & {
      method: 'selectionFrames'
      tableId: string
      selection: SelectionWire
    })
  | (Read & { method: 'overviewSignature'; tableId: string })
  | (Read & {
      method: 'overviewChunk'
      tableId: string
      cursor: OverviewCursor
      limit: number
    })
  | { id: number; method: 'close' }

const TABLE_RE = /^(files|[A-Za-z0-9_-]{1,80})$/

function columns(conn: Database.Database, tableId: string) {
  if (!TABLE_RE.test(tableId)) throw new Error(`Invalid table id: ${tableId}`)
  const cols = conn.prepare(`PRAGMA table_info("${tableId}")`).all() as {
    name: string
  }[]
  return new Set(cols.map((c) => c.name))
}

/** The slow reads (everything but a window), by method. */
function slowRead(conn: Database.Database, msg: ReadRequest): unknown {
  switch (msg.method) {
    case 'tableDuration': {
      const expr = durationExpr(columns(conn, msg.tableId))
      if (!expr) return 0
      const row = conn
        .prepare(`SELECT SUM(${expr}) AS total FROM "${msg.tableId}"`)
        .get() as { total: number | null } | undefined
      return row?.total ?? 0
    }
    case 'selectionFrames':
      return selectionFrames(
        conn,
        msg.tableId,
        Selection.fromWire(msg.selection),
        columns(conn, msg.tableId),
      )
    case 'overviewSignature':
      return readOverviewSignature(conn, msg.tableId)
    case 'overviewChunk':
      return readOverviewChunk(conn, msg.tableId, msg.cursor, msg.limit)
    default:
      throw new Error(`Unknown method: ${(msg as { method?: string }).method}`)
  }
}

const gens: Int32Array | null = workerData?.gens
  ? new Int32Array(workerData.gens as SharedArrayBuffer)
  : null

let db: Database.Database | null = null
let dbPath: string | null = null
const cache = new WindowCache()

function close() {
  cache.clear()
  if (db) {
    try {
      db.close()
    } catch (_) {
      // empty
    }
  }
  db = null
  dbPath = null
}

function open(path: string): Database.Database {
  if (db && dbPath === path) return db
  close()
  // fileMustExist: never create an empty project here (DbWorker owns that).
  db = new Database(path, { readonly: true, fileMustExist: true })
  db.pragma('busy_timeout = 5000')
  dbPath = path
  return db
}

if (!parentPort) throw new Error('DbReadWorker missing parent port')

parentPort.on('message', (msg: ReadRequest) => {
  const post = (data: unknown) =>
    parentPort?.postMessage({ id: msg.id, type: 'result', data })
  try {
    if (msg.method === 'close') {
      close()
      post(null)
      return
    }
    const { slot, gen } = msg
    const stale =
      gens && slot !== null && slot !== undefined
        ? () => Atomics.load(gens, slot) !== gen
        : undefined
    if (stale && stale()) {
      post({ stale: true })
      return
    }
    if (msg.method !== 'readWindow') {
      post(slowRead(open(msg.dbPath), msg))
      return
    }
    const rows = readWindow(
      open(msg.dbPath),
      cache,
      msg.tableId,
      msg.offset,
      msg.limit,
      stale,
    )
    post(rows === null ? { stale: true } : { rows })
  } catch (error) {
    parentPort?.postMessage({
      id: msg.id,
      type: 'error',
      error: error instanceof Error ? error.message : String(error),
    })
  }
})
