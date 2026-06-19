/**
 * General-purpose DB worker thread.
 * Runs synchronous better-sqlite3 queries off the main Electron thread.
 *
 * Each request opens (or reuses) a DB connection, executes the query,
 * and posts the result back. The worker stays alive and handles multiple
 * requests sequentially on its own thread.
 */
import { parentPort } from 'worker_threads'
import { appendFileSync } from 'fs'
import Database from 'better-sqlite3'
import { archive as defaultArchive } from '../constants/defaults'

// TEMP DIAGNOSTIC — remove once tray-load slowness is confirmed fixed.
const DBG = '/tmp/dbworker-perf.log'
const dbg = (line: string) => {
  try {
    appendFileSync(DBG, `${new Date().toISOString()} ${line}\n`)
  } catch (_) {
    // ignore
  }
}
dbg('=== DbWorker started (build with itemsOrderBy fix) ===')

// ── Types ────────────────────────────────────────────────────────────

type DbRequest = {
  id: number
  dbPath: string
} & (
  | { method: 'getTableCount'; tableId: string }
  | { method: 'getFilterCount'; tableId: string }
  | { method: 'getTableDuration'; tableId: string }
  | { method: 'getAllIds'; tableId: string }
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
  | { method: 'deleteFilterRun'; filterId: string }
  | { method: 'updateFilterRunProgress'; filterId: string; processed: number }
  | { method: 'deleteFiles'; fileIds: number[] }
  | { method: 'getFilePathsByIds'; fileIds: number[] }
  | { method: 'deleteRows'; tableId: string; rowIds: number[] }
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
)

type DbResponse =
  | { id: number; type: 'result'; data: any }
  | { id: number; type: 'error'; error: string }

// ── DB connection cache ──────────────────────────────────────────────

let cachedDb: Database.Database | null = null
let cachedDbPath: string | null = null

function getDb(dbPath: string): Database.Database {
  if (cachedDb && cachedDbPath === dbPath) return cachedDb
  if (cachedDb) {
    try {
      cachedDb.close()
    } catch (_) {
      // ignore
    }
  }
  cachedDb = new Database(dbPath)
  cachedDb.pragma('journal_mode = WAL')
  cachedDb.pragma('busy_timeout = 5000')
  cachedDbPath = dbPath
  return cachedDb
}

function validateTableId(id: string) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(id)) {
    throw new Error(`Invalid table/filter ID: ${id}`)
  }
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
        CREATE TABLE IF NOT EXISTS "${tableId}" (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          JSON TEXT,
          sort_order INTEGER DEFAULT NULL
        )
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
  const colNames = getTableColumns(db, tableId)

  if (colNames.has('JSON') && !colNames.has('startFrame')) {
    const startExpr = "COALESCE(json_extract(JSON, '$.startFrame'), 0)"
    const endExpr = `CASE
      WHEN COALESCE(json_extract(JSON, '$.endFrame'), 0) > 0
        THEN json_extract(JSON, '$.endFrame')
      ELSE COALESCE(json_extract(JSON, '$.lastFrame'), 0)
    END`
    const diffExpr = `(${endExpr}) - (${startExpr})`
    const clampedExpr = `CASE WHEN (${diffExpr}) > 0 THEN (${diffExpr}) ELSE 0 END`
    const row = db
      .prepare(`SELECT SUM(${clampedExpr}) AS total FROM "${tableId}"`)
      .get() as { total: number | null } | undefined
    return row?.total ?? 0
  }

  const hasStartFrame = colNames.has('startFrame')
  const hasEndFrame = colNames.has('endFrame')
  const hasLastFrame = colNames.has('lastFrame')

  if (!hasStartFrame && !hasEndFrame && !hasLastFrame) return 0

  const startExpr = hasStartFrame ? 'COALESCE(startFrame, 0)' : '0'
  const endExpr = hasEndFrame
    ? hasLastFrame
      ? 'CASE WHEN COALESCE(endFrame, 0) > 0 THEN endFrame ELSE COALESCE(lastFrame, 0) END'
      : 'COALESCE(endFrame, 0)'
    : hasLastFrame
      ? 'COALESCE(lastFrame, 0)'
      : '0'

  const diffExpr = `(${endExpr}) - (${startExpr})`
  const clampedExpr = `CASE WHEN (${diffExpr}) > 0 THEN (${diffExpr}) ELSE 0 END`

  const row = db
    .prepare(`SELECT SUM(${clampedExpr}) AS total FROM "${tableId}"`)
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

function handleDeleteRowsBySourceId(
  db: Database.Database,
  tableId: string,
  sourceIds: number[],
): number {
  if (sourceIds.length === 0) return 0
  validateTableId(tableId)
  const placeholders = sourceIds.map(() => '?').join(',')
  const result = db
    .prepare(
      `DELETE FROM "${tableId}" WHERE CAST(JSON_EXTRACT(JSON, '$._sourceId') AS INTEGER) IN (${placeholders})`,
    )
    .run(...sourceIds)
  return result.changes
}

function handleDeleteRowsByFilePaths(
  db: Database.Database,
  tableId: string,
  filePaths: string[],
): number {
  if (filePaths.length === 0) return 0
  validateTableId(tableId)
  const placeholders = filePaths.map(() => '?').join(',')
  const result = db
    .prepare(
      `DELETE FROM "${tableId}" WHERE JSON_EXTRACT(JSON, '$.path') IN (${placeholders})`,
    )
    .run(...filePaths)
  return result.changes
}

// ── Paginated query handlers ─────────────────────────────────────────

function handleGetItems(
  db: Database.Database,
  tableId: string,
  limit: number,
  offset: number,
): any[] {
  validateTableId(tableId)
  const __t = Date.now()
  const orderBy = itemsOrderBy(db, tableId)
  const __tOrder = Date.now()
  const rows = db
    .prepare(`SELECT * FROM "${tableId}" ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
    .all(limit, offset)
  dbg(
    `getItems table=${tableId} orderBy="${orderBy}" limit=${limit} offset=${offset} ` +
      `chooseOrderMs=${__tOrder - __t} queryMs=${Date.now() - __tOrder} rows=${(rows as any[]).length}`,
  )
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

  const metadata: any = {
    name: row.name,
    path: row.path,
    createdAt: row.createdAt,
    filters: extra.filters || [],
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
        if (cachedDb) {
          cachedDb.close()
          cachedDb = null
          cachedDbPath = null
        }
      } catch (_) {
        // ignore
      }
      post({ id: msg.id, type: 'closed' })
      return
    }

    const __t0 = Date.now()
    try {
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
        case 'getProcessedSourceIds':
          data = handleGetProcessedSourceIds(db, msg.tableId)
          break
        case 'deleteRowsBySourceId':
          data = handleDeleteRowsBySourceId(db, msg.tableId, msg.sourceIds)
          break
        case 'deleteRowsByFilePaths':
          data = handleDeleteRowsByFilePaths(db, msg.tableId, msg.filePaths)
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
        case 'deleteFiles': {
          const placeholders = msg.fileIds.map(() => '?').join(',')
          db.prepare(`DELETE FROM files WHERE id IN (${placeholders})`).run(
            ...msg.fileIds,
          )
          data = null
          break
        }
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
        case 'deleteRows': {
          validateTableId(msg.tableId)
          const placeholders = msg.rowIds.map(() => '?').join(',')
          db.prepare(
            `DELETE FROM "${msg.tableId}" WHERE id IN (${placeholders})`,
          ).run(...msg.rowIds)
          data = null
          break
        }
        case 'updateSortOrder': {
          validateTableId(msg.tableId)
          // Ensure sort_order column exists
          const cols = db
            .pragma(`table_info("${msg.tableId}")`)
            .map((c: any) => c.name)
          if (!cols.includes('sort_order')) {
            db.exec(
              `ALTER TABLE "${msg.tableId}" ADD COLUMN sort_order INTEGER DEFAULT NULL`,
            )
          }
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
          // Create an expression index matching the custom-sort ORDER BY so
          // getItems/getAllIds stay fast, and so itemsOrderBy() can detect (via
          // this index's existence) that this table is custom-sorted. Dropped
          // automatically if the filter table is later recreated on a re-run.
          db.exec(
            `CREATE INDEX IF NOT EXISTS "idx_${msg.tableId}_sortorder" ON "${msg.tableId}"(COALESCE(sort_order, id), id)`,
          )
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

      const __dur = Date.now() - __t0
      if (__dur > 200) {
        dbg(
          `SLOW method=${msg.method} ${(msg as any).tableId || ''} totalMs=${__dur}`,
        )
      }
      post({ id: msg.id, type: 'result', data })
    } catch (error) {
      const errorText = error instanceof Error ? error.message : String(error)
      dbg(
        `ERROR method=${msg.method} totalMs=${Date.now() - __t0} ${errorText}`,
      )
      post({ id: msg.id, type: 'error', error: errorText })
    }
  },
)
