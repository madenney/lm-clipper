import { FileInterface } from 'constants/types'
import { getDb, setOnCloseCallback } from './dbConnection'
import { archive as defaultArchive } from '../constants/defaults'

// Cache table column info to avoid repeated PRAGMA calls
const schemaCache = new Map<string, Set<string>>()

export function validateTableId(id: string) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(id)) {
    throw new Error(`Invalid table/filter ID: ${id}`)
  }
}

function getTableColumns(path: string, tableId: string): Set<string> {
  validateTableId(tableId)
  const key = `${path}:${tableId}`
  const cached = schemaCache.get(key)
  if (cached) return cached
  const db = getDb(path)
  const cols = db.prepare(`PRAGMA table_info("${tableId}")`).all() as {
    name: string
  }[]
  const names = new Set(cols.map((c) => c.name))
  schemaCache.set(key, names)
  return names
}

export function invalidateSchemaCache(path?: string, tableId?: string) {
  if (path && tableId) {
    schemaCache.delete(`${path}:${tableId}`)
  } else if (path) {
    for (const key of schemaCache.keys()) {
      if (key.startsWith(`${path}:`)) schemaCache.delete(key)
    }
  } else {
    schemaCache.clear()
  }
}

// Clear schema cache when DB connection closes
setOnCloseCallback(() => schemaCache.clear())

export function dbExists(path: string) {
  try {
    const db = getDb(path)
    db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' LIMIT 1",
    ).get()
    return true
  } catch (e) {
    return false
  }
}

export function createDB(
  path: string,
  name: string,
  includeDefaultFilters = true,
) {
  const db = getDb(path)

  db.exec(`
    CREATE TABLE IF NOT EXISTS metadata (
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      extra TEXT DEFAULT '{}'
    )
  `)

  // If an old-schema DB already exists at this path, migrate it
  migrateMetadataIfNeeded(db)

  const filters = includeDefaultFilters
    ? defaultArchive.filters
    : defaultArchive.filters.filter((f) => f.type === 'files')

  const metadata = {
    ...defaultArchive,
    filters,
    path,
    name,
    createdAt: Date.now(),
  }

  const extra = JSON.stringify({ filters: metadata.filters })

  // Only insert if the table is empty (don't duplicate on re-open)
  const existing = db
    .prepare('SELECT COUNT(*) AS count FROM metadata')
    .get() as { count: number }
  if (existing.count === 0) {
    db.prepare(
      'INSERT INTO metadata (name, path, createdAt, extra) VALUES (?, ?, ?, ?)',
    ).run(metadata.name, metadata.path, metadata.createdAt, extra)
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT,
      players TEXT,
      winner INTEGER,
      stage INTEGER,
      startedAt INTEGER,
      lastFrame INTEGER,
      isProcessed INTEGER,
      info TEXT
    )
  `)

  db.exec('CREATE INDEX IF NOT EXISTS idx_files_path ON files(path)')

  db.exec(`
    CREATE TABLE IF NOT EXISTS filter_runs (
      filter_id TEXT PRIMARY KEY,
      params_json TEXT,
      total_input INTEGER,
      status TEXT,
      created_at INTEGER
    )
  `)

  for (const filter of metadata.filters) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS "${filter.id}" (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        JSON TEXT
      )
    `)
  }
}

function migrateMetadataIfNeeded(db: ReturnType<typeof getDb>) {
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
      return // skip migration if metadata is corrupt
    }
    db.exec('ALTER TABLE metadata RENAME TO metadata_old')
    db.exec(`
      CREATE TABLE metadata (
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        extra TEXT DEFAULT '{}'
      )
    `)
    const extra = JSON.stringify({
      filters: old.filters || [],
    })
    db.prepare(
      'INSERT INTO metadata (name, path, createdAt, extra) VALUES (?, ?, ?, ?)',
    ).run(old.name || '', old.path || '', old.createdAt || 0, extra)
    db.exec('DROP TABLE metadata_old')
  }
}

export { getMetaDataAsync as getMetaData } from './dbAsync'

export function updateMetaData(
  path: string,
  metadata: {
    name?: string
    path?: string
    createdAt?: number
    filters?: any[]
    savedCustomFilters?: any[]
    cachedCounts?: Record<string, number>
    files?: number
  },
) {
  const db = getDb(path)
  // Read-merge-write under BEGIN IMMEDIATE. The DbWorker connection writes the
  // same `extra` JSON blob (cachedCounts / cachedFileCount) concurrently, so we
  // must NOT rebuild extra from scratch — that blind-overwrote whichever keys
  // this caller didn't carry. Merge onto the persisted blob and keep the
  // read+write atomic against the other connection. See DbWorker.cacheFilterCount.
  const write = db.transaction(() => {
    let extraObj: any = {}
    try {
      const row = db.prepare('SELECT extra FROM metadata LIMIT 1').get() as
        | { extra?: string }
        | undefined
      extraObj = row?.extra ? JSON.parse(row.extra) : {}
    } catch (_) {
      extraObj = {}
    }
    extraObj.filters = metadata.filters || []
    if (metadata.savedCustomFilters && metadata.savedCustomFilters.length > 0) {
      extraObj.savedCustomFilters = metadata.savedCustomFilters
    }
    if (metadata.cachedCounts) {
      // Merge, don't replace — preserve counts the worker cached for filters
      // not present in this caller's map.
      extraObj.cachedCounts = {
        ...(extraObj.cachedCounts || {}),
        ...metadata.cachedCounts,
      }
    }
    if (metadata.files !== undefined) {
      extraObj.cachedFileCount = metadata.files
    }
    db.prepare(
      'UPDATE metadata SET name = ?, path = ?, createdAt = ?, extra = ?',
    ).run(
      metadata.name || '',
      metadata.path || '',
      metadata.createdAt || 0,
      JSON.stringify(extraObj),
    )
  })
  write.immediate()
}

export function getFileByPath(path: string, filePath: string) {
  const db = getDb(path)
  const row = db
    .prepare('SELECT * FROM files WHERE path = ? LIMIT 1')
    .get(filePath)
  return row || null
}

export function insertFile(path: string, fileJSON: FileInterface) {
  const db = getDb(path)
  db.prepare(
    `
    INSERT INTO files (path, players, winner, stage, startedAt, lastFrame, isProcessed, info)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    fileJSON.path,
    JSON.stringify(fileJSON.players),
    fileJSON.winner,
    fileJSON.stage,
    fileJSON.startedAt || 0,
    fileJSON.lastFrame,
    fileJSON.isProcessed ? 1 : 0,
    fileJSON.info || '',
  )
  invalidateCachedFileCount(db)
}

export function insertFiles(path: string, files: FileInterface[]) {
  if (files.length === 0) return
  if (files.length === 1) return insertFile(path, files[0])

  const db = getDb(path)
  const stmt = db.prepare(`
    INSERT INTO files (path, players, winner, stage, startedAt, lastFrame, isProcessed, info)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)

  const insertMany = db.transaction((items: FileInterface[]) => {
    for (const f of items) {
      stmt.run(
        f.path,
        JSON.stringify(f.players),
        f.winner,
        f.stage,
        f.startedAt || 0,
        f.lastFrame,
        f.isProcessed ? 1 : 0,
        f.info || '',
      )
    }
  })

  insertMany(files)
  invalidateCachedFileCount(db)
}

/**
 * Clear cachedFileCount from metadata extra so the next getMetaData
 * call recounts. This is cheap — just a JSON read/write on one row.
 */
function invalidateCachedFileCount(db: ReturnType<typeof getDb>) {
  try {
    const row = db.prepare('SELECT extra FROM metadata LIMIT 1').get() as
      | { extra: string }
      | undefined
    if (!row) return
    const extra = JSON.parse(row.extra || '{}')
    if (extra.cachedFileCount !== undefined) {
      delete extra.cachedFileCount
      db.prepare('UPDATE metadata SET extra = ?').run(JSON.stringify(extra))
    }
  } catch (_) {
    // non-critical
  }
}

export function getPlayerNameCounts(
  path: string,
): { name: string; total: number }[] {
  const db = getDb(path)
  const rows = db
    .prepare(
      `SELECT
         JSON_EXTRACT(je.value, '$.displayName') AS name,
         COUNT(*) AS total
       FROM files, JSON_EACH(files.players) AS je
       WHERE name IS NOT NULL AND name != ''
       GROUP BY name
       ORDER BY total DESC`,
    )
    .all() as { name: string; total: number }[]
  return rows
}

export function getConnectCodeCounts(
  path: string,
): { name: string; total: number }[] {
  const db = getDb(path)
  const rows = db
    .prepare(
      `SELECT
         JSON_EXTRACT(je.value, '$.connectCode') AS name,
         COUNT(*) AS total
       FROM files, JSON_EACH(files.players) AS je
       WHERE name IS NOT NULL AND name != ''
       GROUP BY name
       ORDER BY total DESC`,
    )
    .all() as { name: string; total: number }[]
  return rows
}

export function getAllFromTable(path: string, tableId: string) {
  const db = getDb(path)
  return db.prepare(`SELECT * FROM "${tableId}"`).all()
}

export function getItemsByIds(path: string, tableId: string, ids: number[]) {
  if (ids.length === 0) return []
  const db = getDb(path)
  const placeholders = ids.map(() => '?').join(',')
  const colNames = getTableColumns(path, tableId)
  const hasSortOrder = colNames.has('sort_order')
  const orderBy = hasSortOrder ? 'COALESCE(sort_order, id), id' : 'id'
  return db
    .prepare(
      `SELECT * FROM "${tableId}" WHERE id IN (${placeholders}) ORDER BY ${orderBy}`,
    )
    .all(...ids)
}

export function insertRow(path: string, tableId: string, rowJSON: any) {
  const db = getDb(path)
  db.prepare(`INSERT INTO "${tableId}" (JSON) VALUES (?)`).run(
    JSON.stringify(rowJSON),
  )
}

export function getItem(path: string, tableId: string, itemId: number) {
  const db = getDb(path)
  return db.prepare(`SELECT * FROM "${tableId}" WHERE id = ?`).get(itemId)
}

export function createFilter(path: string, id: string) {
  const db = getDb(path)
  db.exec(`
    CREATE TABLE IF NOT EXISTS "${id}" (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      JSON TEXT,
      sort_order INTEGER DEFAULT NULL
    )
  `)
  invalidateSchemaCache(path, id)
}

export function deleteFilter(path: string, id: string) {
  const db = getDb(path)
  db.exec(`DROP TABLE IF EXISTS "${id}"`)
  invalidateSchemaCache(path, id)
}

export function upsertFilterRun(
  path: string,
  filterId: string,
  paramsJson: string,
  totalInput: number,
) {
  const db = getDb(path)
  db.prepare(
    `INSERT OR REPLACE INTO filter_runs (filter_id, params_json, total_input, status, created_at)
     VALUES (?, ?, ?, 'running', ?)`,
  ).run(filterId, paramsJson, totalInput, Date.now())
}

export function getFilterRun(path: string, filterId: string) {
  const db = getDb(path)
  return db
    .prepare('SELECT * FROM filter_runs WHERE filter_id = ?')
    .get(filterId) as
    | {
        filter_id: string
        params_json: string
        total_input: number
        status: string
        created_at: number
      }
    | undefined
}

export function deleteFilterRun(path: string, filterId: string) {
  const db = getDb(path)
  db.prepare('DELETE FROM filter_runs WHERE filter_id = ?').run(filterId)
}

export function getFilePathsByIds(path: string, fileIds: number[]): string[] {
  if (fileIds.length === 0) return []
  const db = getDb(path)
  const placeholders = fileIds.map(() => '?').join(',')
  const rows = db
    .prepare(`SELECT path FROM files WHERE id IN (${placeholders})`)
    .all(...fileIds) as { path: string }[]
  return rows.map((r) => r.path)
}

export function deleteFiles(path: string, fileIds: number[]) {
  if (fileIds.length === 0) return
  const db = getDb(path)
  const placeholders = fileIds.map(() => '?').join(',')
  db.prepare(`DELETE FROM files WHERE id IN (${placeholders})`).run(...fileIds)
  invalidateCachedFileCount(db)
}

export function deleteRows(path: string, tableId: string, rowIds: number[]) {
  if (rowIds.length === 0) return
  const db = getDb(path)
  const placeholders = rowIds.map(() => '?').join(',')
  db.prepare(`DELETE FROM "${tableId}" WHERE id IN (${placeholders})`).run(
    ...rowIds,
  )
}

export function updateSortOrder(
  path: string,
  tableId: string,
  updates: { id: number; sort_order: number }[],
) {
  if (updates.length === 0) return
  const db = getDb(path)
  // Ensure sort_order column exists (migration for old tables)
  const colNames = getTableColumns(path, tableId)
  if (!colNames.has('sort_order')) {
    db.exec(
      `ALTER TABLE "${tableId}" ADD COLUMN sort_order INTEGER DEFAULT NULL`,
    )
    invalidateSchemaCache(path, tableId)
  }
  const stmt = db.prepare(`UPDATE "${tableId}" SET sort_order = ? WHERE id = ?`)
  const updateMany = db.transaction((items: typeof updates) => {
    for (const item of items) {
      stmt.run(item.sort_order, item.id)
    }
  })
  updateMany(updates)
}
