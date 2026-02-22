import { FileInterface } from 'constants/types'
import { getDb } from './dbConnection'
import { archive as defaultArchive } from '../constants/defaults'

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

export function createDB(path: string, name: string) {
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

  const metadata = {
    ...defaultArchive,
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

    const old = JSON.parse(row.JSON)
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

export function getMetaData(path: string) {
  const db = getDb(path)

  migrateMetadataIfNeeded(db)

  const row = db
    .prepare('SELECT name, path, createdAt, extra FROM metadata LIMIT 1')
    .get() as
    | { name: string; path: string; createdAt: number; extra: string }
    | undefined

  if (!row) {
    throw new Error('metadata missing')
  }

  let extra: { filters?: any[] } = {}
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
  }

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

  const countRow = db.prepare('SELECT COUNT(*) AS count FROM files').get() as {
    count: number
  }
  metadata.files = countRow.count

  for (const filter of metadata.filters) {
    try {
      const countResult = db
        .prepare(`SELECT COUNT(*) AS count FROM "${filter.id}"`)
        .get() as { count: number }
      filter.results = countResult.count
    } catch (error) {
      console.log(`Missing filter table ${filter.id}, recreating`)
      createFilter(path, filter.id)
      filter.results = 0
      filter.isProcessed = false
      needsUpdate = true
    }
  }

  // Ensure filter_runs table exists (for DBs created before this feature)
  db.exec(`
    CREATE TABLE IF NOT EXISTS filter_runs (
      filter_id TEXT PRIMARY KEY,
      params_json TEXT,
      total_input INTEGER,
      status TEXT,
      created_at INTEGER
    )
  `)

  // Check for resumable filter runs
  for (const filter of metadata.filters) {
    const run = db
      .prepare('SELECT * FROM filter_runs WHERE filter_id = ?')
      .get(filter.id) as { params_json: string; status: string } | undefined
    if (
      run &&
      run.status === 'running' &&
      run.params_json === JSON.stringify(filter.params)
    ) {
      filter.resumable = true
    }
  }

  if (needsUpdate) {
    updateMetaData(path, metadata)
  }

  return metadata
}

export function updateMetaData(
  path: string,
  metadata: {
    name?: string
    path?: string
    createdAt?: number
    filters?: any[]
  },
) {
  const db = getDb(path)
  const extra = JSON.stringify({ filters: metadata.filters || [] })
  db.prepare(
    'UPDATE metadata SET name = ?, path = ?, createdAt = ?, extra = ?',
  ).run(
    metadata.name || '',
    metadata.path || '',
    metadata.createdAt || 0,
    extra,
  )
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
}

export function getFiles(path: string) {
  const db = getDb(path)
  return db.prepare('SELECT * FROM files').all()
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
  return db
    .prepare(`SELECT * FROM "${tableId}" WHERE id IN (${placeholders})`)
    .all(...ids)
}

export function insertRow(path: string, tableId: string, rowJSON: any) {
  const db = getDb(path)
  db.prepare(`INSERT INTO "${tableId}" (JSON) VALUES (?)`).run(
    JSON.stringify(rowJSON),
  )
}

export function getTableLength(path: string, tableId: string) {
  const db = getDb(path)
  const row = db
    .prepare(`SELECT COUNT(*) AS count FROM "${tableId}"`)
    .get() as { count: number }
  return row.count
}

export function getMaxFileId(path: string) {
  const db = getDb(path)
  const row = db
    .prepare('SELECT COALESCE(MAX(id), 0) AS max_id FROM files')
    .get() as { max_id: number }
  return row.max_id
}

export function deleteFilesAfterId(path: string, id: number) {
  const safeId = Math.max(0, Math.floor(id))
  const db = getDb(path)
  db.prepare('DELETE FROM files WHERE id > ?').run(safeId)
}

export function getItem(path: string, tableId: string, itemId: number) {
  const db = getDb(path)
  return db.prepare(`SELECT * FROM "${tableId}" WHERE id = ?`).get(itemId)
}

export function getItems(
  path: string,
  tableId: string,
  limit: number,
  offset: number,
) {
  const db = getDb(path)
  return db
    .prepare(`SELECT * FROM "${tableId}" ORDER BY id LIMIT ? OFFSET ?`)
    .all(limit, offset)
}

export function getItemsLite(path: string, limit: number, offset: number) {
  const db = getDb(path)
  return db
    .prepare('SELECT id, stage FROM files ORDER BY id LIMIT ? OFFSET ?')
    .all(limit, offset)
}

export function getTableCount(path: string, tableId: string): number {
  const db = getDb(path)
  const row = db.prepare(`SELECT COUNT(*) AS count FROM "${tableId}"`).get() as
    | { count: number }
    | undefined
  return row?.count ?? 0
}

export function createFilter(path: string, id: string) {
  const db = getDb(path)
  db.exec(`
    CREATE TABLE IF NOT EXISTS "${id}" (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      JSON TEXT
    )
  `)
}

export function deleteFilter(path: string, id: string) {
  const db = getDb(path)
  db.exec(`DROP TABLE IF EXISTS "${id}"`)
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

export function getProcessedSourceIds(path: string, tableId: string): number[] {
  const db = getDb(path)
  try {
    const rows = db
      .prepare(
        `SELECT DISTINCT CAST(JSON_EXTRACT(JSON, '$._sourceId') AS INTEGER) AS sid
         FROM "${tableId}"
         WHERE JSON_EXTRACT(JSON, '$._sourceId') IS NOT NULL`,
      )
      .all() as { sid: number }[]
    return rows.map((r) => r.sid)
  } catch (_) {
    return []
  }
}
