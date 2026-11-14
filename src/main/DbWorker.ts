/**
 * General-purpose DB worker thread.
 * Runs synchronous better-sqlite3 queries off the main Electron thread.
 *
 * Each request opens (or reuses) a DB connection, executes the query,
 * and posts the result back. The worker stays alive and handles multiple
 * requests sequentially on its own thread.
 */
import fs from 'fs'
import { parentPort } from 'worker_threads'
import Database from 'better-sqlite3'
import {
  RESULTS_TABLE_COLUMNS,
  readOverviewChunk,
  readOverviewSignature,
  type OverviewCursor,
} from './overview'
import { archive as defaultArchive } from '../constants/defaults'
import { getDb as sharedGetDb, closeDb as sharedCloseDb } from './dbConnection'
import { WORKER_SYNC_FNS } from './db'
import { validateTableId } from './tableId'
import { LIBRARY_FNS, closeLibraries } from './replayLibrary'
import { markManualOrder } from './manualOrder'
import { durationExpr, selectionFrames, selectionIds } from './selectionSql'
import { Selection, type SelectionWire } from '../lib/selection'
import * as removeRows from './removeRows'

// ── Types ────────────────────────────────────────────────────────────

type DbRequest = {
  id: number
  dbPath: string
} & (
  | { method: 'getTableCount'; tableId: string }
  | { method: 'getFilterCount'; tableId: string }
  | { method: 'getTableDuration'; tableId: string }
  | { method: 'getAllIds'; tableId: string }
  | {
      method: 'selectionIds'
      tableId: string
      selection: SelectionWire
      limit?: number
    }
  | { method: 'selectionFrames'; tableId: string; selection: SelectionWire }
  | { method: 'getProcessedSourceIds'; tableId: string }
  | { method: 'deleteRowsBySourceId'; tableId: string; sourceIds: number[] }
  | {
      method: 'deleteRowsByFilePaths'
      tableId: string
      filePaths: string[]
    }
  | { method: 'getMetadata' }
  | { method: 'getItems'; tableId: string; limit: number; offset: number }
  | { method: 'getItemsLite'; limit: number; offset: number }
  | { method: 'getOverviewSignature'; tableId: string }
  | {
      method: 'getOverviewChunk'
      tableId: string
      cursor: OverviewCursor
      limit: number
    }
  | { method: 'deleteFilterRun'; filterId: string }
  | { method: 'updateFilterRunProgress'; filterId: string; processed: number }
  | { method: 'deleteFiles'; fileIds: number[] }
  | { method: 'getFilePathsByIds'; fileIds: number[] }
  | { method: 'deleteRows'; tableId: string; rowIds: number[] }
  | { method: 'removeGames'; fileIds: number[]; filterIds: string[] }
  | {
      method: 'removeResultsCascade'
      tableId: string
      rowIds: number[]
      downstream: removeRows.DownstreamStep[]
    }
  | {
      method: 'removeGamesFromProjectFile'
      projectPath: string
      paths: string[]
    }
  | {
      method: 'updateSortOrder'
      tableId: string
      updates: { id: number; sort_order: number }[]
    }
  | { method: 'updateMetadataName'; name: string }
  | { method: 'updateMetadataPathAndName'; path: string; name: string }
  | {
      method: 'getGameFilterRowInfo'
      tableId: string
      rowIds: number[]
    }
  | { method: 'updateMetadataField'; field: string; value: string }
  | { method: 'callSync'; fn: keyof typeof WORKER_SYNC_FNS; args: any[] }
  | { method: 'library'; fn: keyof typeof LIBRARY_FNS; args: any[] }
  | { method: 'closeDb' }
)

type DbResponse =
  | { id: number; type: 'result'; data: any }
  | { id: number; type: 'error'; error: string }

// ── DB connection cache ──────────────────────────────────────────────

let cachedDb: Database.Database | null = null
let cachedDbPath: string | null = null

// One connection for this thread, shared with the db.ts functions run through
// 'callSync', so every main-process request uses the same connection in order.
function getDb(dbPath: string): Database.Database {
  if (cachedDb && cachedDbPath === dbPath) return cachedDb
  // eslint-disable-next-line no-use-before-define
  columnCache.clear()
  cachedDb = sharedGetDb(dbPath)
  cachedDbPath = dbPath
  return cachedDb
}

function closeConnection() {
  sharedCloseDb() // checkpoints the WAL, then closes
  cachedDb = null
  cachedDbPath = null
  // eslint-disable-next-line no-use-before-define
  columnCache.clear()
}

// ── Column cache (mirrors db.ts getTableColumns) ─────────────────────

const columnCache = new Map<string, Set<string>>()

function getTableColumns(db: Database.Database, tableId: string): Set<string> {
  validateTableId(tableId)
  const cached = columnCache.get(tableId)
  if (cached) return cached
  const cols = db.prepare(`PRAGMA table_info("${tableId}")`).all() as {
    name: string
  }[]
  const names = new Set(cols.map((c) => c.name))
  columnCache.set(tableId, names)
  return names
}

// ── Handler implementations ──────────────────────────────────────────

function handleGetTableCount(db: Database.Database, tableId: string): number {
  validateTableId(tableId)
  const row = db.prepare(`SELECT COUNT(*) AS count FROM "${tableId}"`).get() as
    | { count: number }
    | undefined
  return row?.count ?? 0
}

// Persist a freshly-computed count into the metadata cache so the next project
// open can show it instantly without a full-table COUNT(*).
function cacheFilterCount(
  db: Database.Database,
  tableId: string,
  count: number,
) {
  // BEGIN IMMEDIATE so this read-modify-write of the shared `extra` JSON blob is
  // atomic against the main-thread connection's updateMetaData (which writes the
  // same column). Without it the two connections race and silently clobber each
  // other's keys (cachedCounts / filters / isProcessed). See updateMetaData.
  const write = db.transaction(() => {
    const row = db.prepare('SELECT extra FROM metadata LIMIT 1').get() as
      | { extra: string }
      | undefined
    if (!row) return
    let extra: any = {}
    try {
      extra = JSON.parse(row.extra || '{}')
    } catch (_) {
      extra = {}
    }
    if (tableId === 'files') {
      extra.cachedFileCount = count
    } else {
      extra.cachedCounts = extra.cachedCounts || {}
      extra.cachedCounts[tableId] = count
    }
    db.prepare('UPDATE metadata SET extra = ?').run(JSON.stringify(extra))
  })
  write.immediate()
}

// Lazy per-table count used to hydrate the UI after open. Computes COUNT(*)
// (a full scan on big tables — that's why it runs off the open path), caches
// the result, and returns it. Creates a missing filter table rather than
// throwing so a partially-built project still loads.
function handleGetFilterCount(db: Database.Database, tableId: string): number {
  validateTableId(tableId)
  let count: number
  try {
    const row = db
      .prepare(`SELECT COUNT(*) AS count FROM "${tableId}"`)
      .get() as { count: number } | undefined
    count = row?.count ?? 0
  } catch (_) {
    if (tableId !== 'files') {
      db.exec(`
        CREATE TABLE IF NOT EXISTS "${tableId}" (${RESULTS_TABLE_COLUMNS})
      `)
    }
    count = 0
  }
  try {
    cacheFilterCount(db, tableId, count)
  } catch (_) {
    // caching is best-effort; never fail the count on a cache-write error
  }
  return count
}

function handleGetTableDuration(
  db: Database.Database,
  tableId: string,
): number {
  validateTableId(tableId)
  const expr = durationExpr(getTableColumns(db, tableId))
  if (!expr) return 0
  const row = db
    .prepare(`SELECT SUM(${expr}) AS total FROM "${tableId}"`)
    .get() as { total: number | null } | undefined
  return row?.total ?? 0
}

// Choose the ORDER BY for displaying rows. Default to the integer primary key
// (`id`) — that's an index walk, so LIMIT/OFFSET is instant even on 48M+ rows.
// Only fall back to the custom-sort ordering when a sort has actually been
// applied, which we detect by the presence of the expression index that
// updateSortOrder creates. (We can't cheaply test `sort_order IS NOT NULL` —
// on a 48M-row table with no custom sort, that scan alone takes ~30s. And for
// an unsorted table COALESCE(sort_order, id) === id, so `id` is identical.)
function itemsOrderBy(db: Database.Database, tableId: string): string {
  const sorted = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='index' AND name = ? LIMIT 1",
    )
    .get(`idx_${tableId}_sortorder`)
  return sorted ? 'COALESCE(sort_order, id), id' : 'id'
}

function handleGetAllIds(db: Database.Database, tableId: string): string[] {
  validateTableId(tableId)
  const orderBy = itemsOrderBy(db, tableId)
  const rows = db
    .prepare(`SELECT id FROM "${tableId}" ORDER BY ${orderBy}`)
    .all() as { id: number }[]
  return rows.map((r) => String(r.id))
}

function handleGetProcessedSourceIds(
  db: Database.Database,
  tableId: string,
): number[] {
  validateTableId(tableId)
  // Verify table exists before querying — propagate error if missing
  const tableExists = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(tableId)
  if (!tableExists) {
    throw new Error(`Filter table "${tableId}" does not exist`)
  }
  const rows = db
    .prepare(
      `SELECT DISTINCT CAST(JSON_EXTRACT(JSON, '$._sourceId') AS INTEGER) AS sid
       FROM "${tableId}"
       WHERE JSON_EXTRACT(JSON, '$._sourceId') IS NOT NULL`,
    )
    .all() as { sid: number }[]
  return rows.map((r) => r.sid)
}

// ── Paginated query handlers ─────────────────────────────────────────

function handleGetItems(
  db: Database.Database,
  tableId: string,
  limit: number,
  offset: number,
): any[] {
  validateTableId(tableId)
  const orderBy = itemsOrderBy(db, tableId)
  const rows = db
    .prepare(`SELECT * FROM "${tableId}" ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
    .all(limit, offset)
  return rows
}

function handleGetItemsLite(
  db: Database.Database,
  limit: number,
  offset: number,
): any[] {
  return db
    .prepare('SELECT id, stage FROM files ORDER BY id LIMIT ? OFFSET ?')
    .all(limit, offset)
}

// ── Metadata handler ─────────────────────────────────────────────────

function migrateMetadataIfNeeded(db: Database.Database) {
  const columns = db.pragma('table_info(metadata)') as Array<{ name: string }>
  const colNames = columns.map((c) => c.name)

  if (colNames.length === 1 && colNames[0] === 'JSON') {
    const row = db.prepare('SELECT JSON FROM metadata LIMIT 1').get() as
      | { JSON: string }
      | undefined
    if (!row) return

    let old: any
    try {
      old = JSON.parse(row.JSON)
    } catch {
      return
    }
    db.transaction(() => {
      db.exec('ALTER TABLE metadata RENAME TO metadata_old')
      db.exec(`
        CREATE TABLE metadata (
          name TEXT NOT NULL,
          path TEXT NOT NULL,
          createdAt INTEGER NOT NULL,
          extra TEXT DEFAULT '{}'
        )
      `)
      const extra = JSON.stringify({ filters: old.filters || [] })
      db.prepare(
        'INSERT INTO metadata (name, path, createdAt, extra) VALUES (?, ?, ?, ?)',
      ).run(old.name || '', old.path || '', old.createdAt || 0, extra)
      db.exec('DROP TABLE metadata_old')
    })()
  }
}

function handleGetMetadata(db: Database.Database) {
  migrateMetadataIfNeeded(db)

  const row = db
    .prepare('SELECT name, path, createdAt, extra FROM metadata LIMIT 1')
    .get() as
    | { name: string; path: string; createdAt: number; extra: string }
    | undefined

  if (!row) throw new Error('metadata missing')

  let extra: {
    filters?: any[]
    savedCustomFilters?: any[]
    cachedCounts?: Record<string, number>
    cachedFileCount?: number
  } = {}
  try {
    extra = JSON.parse(row.extra || '{}')
  } catch (_) {
    // empty
  }

  // Filter ids become SQL identifiers; a project file from someone else may carry
  // one that is not a plain name (SQL in a table name). Such steps are left out.
  const safeFilters = (extra.filters || []).filter(
    (f: { id?: unknown }) =>
      typeof f?.id === 'string' && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(f.id),
  )
  if (safeFilters.length !== (extra.filters || []).length)
    console.error(
      'Project has steps with unusable ids; they were left out:',
      (extra.filters || []).length - safeFilters.length,
    )
  const metadata: any = {
    name: row.name,
    path: row.path,
    createdAt: row.createdAt,
    filters: safeFilters,
    savedCustomFilters: extra.savedCustomFilters || [],
  }
  const cachedCounts: Record<string, number> = extra.cachedCounts || {}

  let needsUpdate = false

  const gameFilterIndex = metadata.filters.findIndex(
    (filter: { type?: string }) => filter.type === 'files',
  )
  if (gameFilterIndex === -1) {
    const template = defaultArchive.filters.find(
      (filter) => filter.type === 'files',
    )
    if (template) {
      const usedIds = new Set(
        metadata.filters.map((filter: { id: string }) => filter.id),
      )
      let id = template.id || `filter_${Date.now()}`
      if (usedIds.has(id)) {
        id = `filter_${Date.now()}`
      }
      metadata.filters.unshift({
        ...template,
        id,
        params: { ...(template.params || {}) },
      })
      needsUpdate = true
    }
  } else if (gameFilterIndex > 0) {
    const [gameFilter] = metadata.filters.splice(gameFilterIndex, 1)
    metadata.filters.unshift(gameFilter)
    needsUpdate = true
  }

  // Counts are loaded lazily (see getFilterCount). Opening a project must never
  // block on a full-table COUNT(*) — on a multi-million-row table that scan
  // takes tens of seconds. So we only fill in counts we already have cached;
  // anything uncached is left null, and the renderer shows a spinner and
  // hydrates it in the background after the window is already interactive.
  metadata.files =
    extra.cachedFileCount !== undefined && extra.cachedFileCount >= 0
      ? extra.cachedFileCount
      : null

  for (const filter of metadata.filters) {
    filter.results =
      cachedCounts[filter.id] !== undefined && cachedCounts[filter.id] >= 0
        ? cachedCounts[filter.id]
        : null
  }
  // Preserve the existing cache untouched; lazy counts update it as they resolve.
  const newCachedCounts: Record<string, number> = cachedCounts

  db.exec(`
    CREATE TABLE IF NOT EXISTS filter_runs (
      filter_id TEXT PRIMARY KEY,
      params_json TEXT,
      total_input INTEGER,
      status TEXT,
      created_at INTEGER
    )
  `)

  metadata.cachedCounts = newCachedCounts

  // Check for resumable filter runs
  // Clear any stale resumable flags from stored metadata before re-checking
  for (const filter of metadata.filters) {
    delete filter.resumable
    delete filter.resumeProgress
  }
  for (const filter of metadata.filters) {
    const run = db
      .prepare('SELECT * FROM filter_runs WHERE filter_id = ?')
      .get(filter.id) as
      | {
          params_json: string
          status: string
          total_input: number
          processed?: number
        }
      | undefined
    if (
      run &&
      run.status === 'running' &&
      run.params_json === JSON.stringify(filter.params)
    ) {
      filter.resumable = true
      filter.resumeProgress = {
        processed: run.processed ?? 0,
        totalInput: run.total_input,
      }
    }
  }

  if (needsUpdate) {
    const extraObj: any = { filters: metadata.filters }
    if (metadata.savedCustomFilters && metadata.savedCustomFilters.length > 0) {
      extraObj.savedCustomFilters = metadata.savedCustomFilters
    }
    if (metadata.cachedCounts) {
      extraObj.cachedCounts = metadata.cachedCounts
    }
    if (typeof metadata.files === 'number') {
      extraObj.cachedFileCount = metadata.files
    }
    const extraStr = JSON.stringify(extraObj)
    db.prepare(
      'UPDATE metadata SET name = ?, path = ?, createdAt = ?, extra = ?',
    ).run(
      metadata.name || '',
      metadata.path || '',
      metadata.createdAt || 0,
      extraStr,
    )
  }

  return metadata
}

// ── Message handler ──────────────────────────────────────────────────

if (!parentPort) {
  throw new Error('DbWorker missing parent port')
}

parentPort.on(
  'message',
  (msg: DbRequest | { id: number; __control: 'close' }) => {
    const post = (response: DbResponse | { id: number; type: 'closed' }) =>
      parentPort?.postMessage(response)

    // Graceful shutdown: cleanly close our cached connection (checkpoints the WAL
    // and releases the file handle) so the main process can delete the orphaned
    // -wal/-shm sidecars at quit. Replies 'closed' so the caller can stop waiting.
    if ('__control' in msg) {
      try {
        closeConnection()
        closeLibraries()
      } catch (_) {
        // ignore
      }
      post({ id: msg.id, type: 'closed' })
      return
    }

    if (msg.method === 'closeDb') {
      try {
        closeConnection()
        post({ id: msg.id, type: 'result', data: null })
      } catch (error) {
        const errorText = error instanceof Error ? error.message : String(error)
        post({ id: msg.id, type: 'error', error: errorText })
      }
      return
    }

    try {
      // The replay library has its own connection; the project one is untouched.
      if (msg.method === 'library') {
        const fn = LIBRARY_FNS[msg.fn] as (..._args: any[]) => any
        if (typeof fn !== 'function') {
          throw new Error(`Unknown library function: ${String(msg.fn)}`)
        }
        post({ id: msg.id, type: 'result', data: fn(...msg.args) })
        return
      }
      // Another project than the open one (My Replays): its own connection,
      // closed again, so the open project's connection is untouched.
      if (msg.method === 'removeGamesFromProjectFile') {
        let games = 0
        if (fs.existsSync(msg.projectPath)) {
          const other = new Database(msg.projectPath)
          try {
            other.pragma('busy_timeout = 5000')
            games = removeRows.removeGamesByPaths(other, msg.paths)
          } finally {
            other.close()
          }
        }
        post({ id: msg.id, type: 'result', data: games })
        return
      }
      if (msg.method === 'callSync') {
        const fn = WORKER_SYNC_FNS[msg.fn] as (..._args: any[]) => any
        if (typeof fn !== 'function') {
          throw new Error(`Unknown sync function: ${String(msg.fn)}`)
        }
        post({ id: msg.id, type: 'result', data: fn(...msg.args) })
        // db.ts may have opened or switched this thread's connection.
        cachedDb = null
        cachedDbPath = null
        return
      }
      const db = getDb(msg.dbPath)
      let data: any

      switch (msg.method) {
        case 'getTableCount':
          data = handleGetTableCount(db, msg.tableId)
          break
        case 'getFilterCount':
          data = handleGetFilterCount(db, msg.tableId)
          break
        case 'getTableDuration':
          data = handleGetTableDuration(db, msg.tableId)
          break
        case 'getAllIds':
          data = handleGetAllIds(db, msg.tableId)
          break
        case 'selectionIds':
          validateTableId(msg.tableId)
          data = selectionIds(
            db,
            msg.tableId,
            Selection.fromWire(msg.selection),
            itemsOrderBy(db, msg.tableId),
            msg.limit && msg.limit > 0 ? msg.limit : Infinity,
          )
          break
        case 'selectionFrames':
          data = selectionFrames(
            db,
            msg.tableId,
            Selection.fromWire(msg.selection),
            getTableColumns(db, msg.tableId),
          )
          break
        case 'getProcessedSourceIds':
          data = handleGetProcessedSourceIds(db, msg.tableId)
          break
        case 'deleteRowsBySourceId':
          data = removeRows.deleteRowsBySourceId(db, msg.tableId, msg.sourceIds)
          break
        case 'deleteRowsByFilePaths':
          data = removeRows.deleteRowsByFilePaths(
            db,
            msg.tableId,
            msg.filePaths,
          )
          break
        case 'getMetadata':
          data = handleGetMetadata(db)
          break
        case 'getItems':
          data = handleGetItems(db, msg.tableId, msg.limit, msg.offset)
          break
        case 'getItemsLite':
          data = handleGetItemsLite(db, msg.limit, msg.offset)
          break
        case 'getOverviewSignature':
          data = readOverviewSignature(db, msg.tableId)
          break
        case 'getOverviewChunk':
          data = readOverviewChunk(db, msg.tableId, msg.cursor, msg.limit)
          break
        case 'deleteFilterRun': {
          const beforeCount = (
            db
              .prepare(
                'SELECT COUNT(*) AS cnt FROM filter_runs WHERE filter_id = ?',
              )
              .get(msg.filterId) as any
          )?.cnt
          const result = db
            .prepare('DELETE FROM filter_runs WHERE filter_id = ?')
            .run(msg.filterId)
          const afterCount = (
            db
              .prepare(
                'SELECT COUNT(*) AS cnt FROM filter_runs WHERE filter_id = ?',
              )
              .get(msg.filterId) as any
          )?.cnt
          console.log(
            `[DbWorker deleteFilterRun] filterId=${msg.filterId} before=${beforeCount} deleted=${result.changes} after=${afterCount}`,
          )
          data = null
          break
        }
        case 'updateFilterRunProgress':
          // Add processed column if it doesn't exist (migration). Only the
          // "duplicate column" case is expected/benign — any other error
          // (missing table, locked db, disk full) must surface, not be hidden.
          try {
            db.exec(
              'ALTER TABLE filter_runs ADD COLUMN processed INTEGER DEFAULT 0',
            )
          } catch (e) {
            const m = (e as { message?: string })?.message || ''
            if (!/duplicate column name/i.test(m)) throw e
          }
          db.prepare(
            'UPDATE filter_runs SET processed = ? WHERE filter_id = ?',
          ).run(msg.processed, msg.filterId)
          data = null
          break
        case 'deleteFiles':
          // Keeps the cached game count true (removeRows.ts).
          removeRows.deleteFiles(db, msg.fileIds)
          data = null
          break
        case 'removeGames':
          // Games and every filter row made from them; returns their paths.
          data = removeRows.removeGamesByIds(db, msg.fileIds, msg.filterIds)
          break
        case 'removeResultsCascade':
          data = removeRows.removeResultsCascade(
            db,
            msg.tableId,
            msg.rowIds,
            msg.downstream,
          )
          break
        case 'getFilePathsByIds': {
          if (!msg.fileIds || msg.fileIds.length === 0) {
            data = []
          } else {
            const placeholders = msg.fileIds.map(() => '?').join(',')
            const rows = db
              .prepare(`SELECT path FROM files WHERE id IN (${placeholders})`)
              .all(...msg.fileIds) as { path: string }[]
            data = rows.map((r) => r.path)
          }
          break
        }
        case 'deleteRows':
          removeRows.deleteRows(db, msg.tableId, msg.rowIds)
          data = null
          break
        case 'updateSortOrder': {
          validateTableId(msg.tableId)
          // Adds sort_order if missing and the expression index matching the
          // custom-sort ORDER BY: it keeps getItems/getAllIds fast, marks the
          // table as custom-sorted for itemsOrderBy(), and makes the next filter
          // keep this order (manualOrder.ts). Dropped with the table on a re-run.
          markManualOrder(db, msg.tableId)
          const stmt = db.prepare(
            `UPDATE "${msg.tableId}" SET sort_order = ? WHERE id = ?`,
          )
          const txn = db.transaction(
            (updates: { id: number; sort_order: number }[]) => {
              for (const u of updates) {
                stmt.run(u.sort_order, u.id)
              }
            },
          )
          txn(msg.updates)
          data = null
          break
        }
        case 'updateMetadataName': {
          db.prepare('UPDATE metadata SET name = ?').run(msg.name)
          data = null
          break
        }
        case 'updateMetadataPathAndName': {
          db.prepare('UPDATE metadata SET path = ?, name = ?').run(
            msg.path,
            msg.name,
          )
          data = null
          break
        }
        case 'getGameFilterRowInfo': {
          validateTableId(msg.tableId)
          const placeholders = msg.rowIds.map(() => '?').join(',')
          data = db
            .prepare(
              `SELECT CAST(JSON_EXTRACT(JSON, '$.id') AS INTEGER) AS fileId, JSON_EXTRACT(JSON, '$.path') AS filePath FROM "${msg.tableId}" WHERE id IN (${placeholders})`,
            )
            .all(...msg.rowIds)
          break
        }
        case 'updateMetadataField': {
          db.prepare(
            `UPDATE metadata SET ${msg.field} = ? WHERE rowid = 1`,
          ).run(msg.value)
          data = null
          break
        }
        default:
          throw new Error(`Unknown method: ${(msg as any).method}`)
      }

      post({ id: msg.id, type: 'result', data })
    } catch (error) {
      const errorText = error instanceof Error ? error.message : String(error)
      post({ id: msg.id, type: 'error', error: errorText })
    }
  },
)
