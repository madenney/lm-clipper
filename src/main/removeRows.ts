/**
 * Row deletes that keep the project's cached counts true.
 *
 * getMetadata answers the tray's totals from metadata.extra (cachedFileCount for
 * the files table, cachedCounts[filterId] for a filter table) without a COUNT(*),
 * and the renderer only recounts a total that is null. A delete that left those
 * numbers alone kept the old total forever: removing every game showed
 * "0 / 300 games" and a grid of empty placeholder tiles, even after reopening the
 * project. So each delete here takes the rows it removed off the cached count in
 * the same transaction (a count that isn't cached stays uncached).
 */
import type Database from 'better-sqlite3'
import { validateTableId } from './tableId'

const FILES = 'files'

/** Take `removed` rows off a table's cached count, if it has one. */
export function reduceCachedCount(
  db: Database.Database,
  tableId: string,
  removed: number,
) {
  if (!(removed > 0)) return
  const row = db.prepare('SELECT extra FROM metadata LIMIT 1').get() as
    | { extra?: string }
    | undefined
  if (!row) return
  let extra: any
  try {
    extra = JSON.parse(row.extra || '{}')
  } catch (_) {
    return
  }
  if (!extra || typeof extra !== 'object') return
  const less = (n: unknown) =>
    typeof n === 'number' && n >= 0 ? Math.max(0, n - removed) : undefined
  if (tableId === FILES) {
    const next = less(extra.cachedFileCount)
    if (next === undefined) return
    extra.cachedFileCount = next
  } else {
    const next = less(extra.cachedCounts?.[tableId])
    if (next === undefined) return
    extra.cachedCounts[tableId] = next
  }
  db.prepare('UPDATE metadata SET extra = ?').run(JSON.stringify(extra))
}

/**
 * Run a DELETE and update the table's cached count atomically (BEGIN IMMEDIATE:
 * the main thread's connection writes the same metadata row). Returns the
 * number of rows removed.
 */
function deleteCounted(
  db: Database.Database,
  tableId: string,
  sql: string,
  /** null: the statement takes none (it names its rows another way). */
  params: unknown[] | null,
): number {
  if (params && params.length === 0) return 0
  db.exec('BEGIN IMMEDIATE')
  try {
    const { changes } = db.prepare(sql).run(...(params ?? []))
    const removed = Number(changes) || 0
    reduceCachedCount(db, tableId, removed)
    db.exec('COMMIT')
    return removed
  } catch (err) {
    try {
      db.exec('ROLLBACK')
    } catch (_) {
      // already rolled back
    }
    throw err
  }
}

const marks = (n: number) => new Array(n).fill('?').join(',')

/** Remove games from the files table. */
export function deleteFiles(db: Database.Database, fileIds: number[]) {
  return deleteCounted(
    db,
    FILES,
    `DELETE FROM files WHERE id IN (${marks(fileIds.length)})`,
    fileIds,
  )
}

/** Remove rows of a filter table by row id. */
export function deleteRows(
  db: Database.Database,
  tableId: string,
  rowIds: number[],
) {
  validateTableId(tableId)
  return deleteCounted(
    db,
    tableId,
    `DELETE FROM "${tableId}" WHERE id IN (${marks(rowIds.length)})`,
    rowIds,
  )
}

/** Remove a filter table's rows made from these replay files. */
export function deleteRowsByFilePaths(
  db: Database.Database,
  tableId: string,
  filePaths: string[],
) {
  validateTableId(tableId)
  return deleteCounted(
    db,
    tableId,
    `DELETE FROM "${tableId}" WHERE JSON_EXTRACT(JSON, '$.path') IN (${marks(filePaths.length)})`,
    filePaths,
  )
}

/** Remove a filter table's rows made from these source rows. */
export function deleteRowsBySourceId(
  db: Database.Database,
  tableId: string,
  sourceIds: number[],
) {
  validateTableId(tableId)
  return deleteCounted(
    db,
    tableId,
    `DELETE FROM "${tableId}" WHERE CAST(JSON_EXTRACT(JSON, '$._sourceId') AS INTEGER) IN (${marks(sourceIds.length)})`,
    sourceIds,
  )
}

// ── Removing games, and results with what was made from them ─────────

/** The filter tables a project lists (metadata.extra.filters). */
export function projectFilterIds(db: Database.Database): string[] {
  const row = db.prepare('SELECT extra FROM metadata LIMIT 1').get() as
    | { extra?: string }
    | undefined
  try {
    const extra = JSON.parse(row?.extra || '{}')
    return (Array.isArray(extra.filters) ? extra.filters : [])
      .map((f: { id?: unknown }) => f?.id)
      .filter(
        (id: unknown): id is string =>
          typeof id === 'string' && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(id),
      )
  } catch (_) {
    return []
  }
}

const tableExists = (db: Database.Database, tableId: string) =>
  !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableId)

/**
 * Remove games from a project: their files rows and every row of every filter
 * table made from them (rows carry their game's path). At most a few thousand
 * ids per call (SQLite's bound-value limit). Returns the games' paths.
 */
export function removeGamesByIds(
  db: Database.Database,
  fileIds: number[],
  filterIds: string[],
): string[] {
  if (fileIds.length === 0) return []
  const paths = (
    db
      .prepare(`SELECT path FROM files WHERE id IN (${marks(fileIds.length)})`)
      .all(...fileIds) as { path: string }[]
  )
    .map((r) => r.path)
    .filter((p) => typeof p === 'string' && p.length > 0)
  deleteFiles(db, fileIds)
  if (paths.length > 0)
    for (const id of filterIds)
      if (tableExists(db, id)) deleteRowsByFilePaths(db, id, paths)
  return paths
}

/**
 * Remove games from a project by path (a project other than the open one: My
 * Replays), with every filter row made from them. Returns how many it had.
 */
export function removeGamesByPaths(
  db: Database.Database,
  paths: string[],
): number {
  if (paths.length === 0 || !tableExists(db, FILES)) return 0
  const filterIds = projectFilterIds(db)
  let games = 0
  for (let i = 0; i < paths.length; i += 5000) {
    const chunk = paths.slice(i, i + 5000)
    games += deleteCounted(
      db,
      FILES,
      `DELETE FROM files WHERE path IN (${marks(chunk.length)})`,
      chunk,
    )
    for (const id of filterIds)
      if (tableExists(db, id)) deleteRowsByFilePaths(db, id, chunk)
  }
  return games
}

/** A step after the one results are removed from, in order. */
export type DownstreamStep = { id: string; type: string }

/**
 * Remove result rows from a filter step and every row the later steps made
 * from them. A row of the next step came from a removed row when:
 *  - the step is a Sort: it is a verbatim copy (Sort copies the JSON as is);
 *  - otherwise its `_sourceId` (the input row id the filter worker stamps on
 *    each row it writes) is a removed row's id;
 *  - a row without `_sourceId` (code that built new objects in a batch): same
 *    game and frames as a removed row.
 * One scan per step. Returns the rows removed per step.
 */
export function removeResultsCascade(
  db: Database.Database,
  tableId: string,
  rowIds: number[],
  downstream: DownstreamStep[],
): Record<string, number> {
  validateTableId(tableId)
  const removed: Record<string, number> = {}
  if (rowIds.length === 0) return removed
  const cols = 'id INTEGER PRIMARY KEY, json TEXT, path TEXT, s, e'
  const pick = (from: string) =>
    `SELECT t.id, t.JSON, JSON_EXTRACT(t.JSON, '$.path'), JSON_EXTRACT(t.JSON, '$.startFrame'), JSON_EXTRACT(t.JSON, '$.endFrame') FROM "${from}" AS t`
  const drop = () =>
    db.exec(
      'DROP TABLE IF EXISTS temp.rm_prev; DROP TABLE IF EXISTS temp.rm_next;',
    )
  drop()
  db.exec(
    `CREATE TEMP TABLE rm_prev (${cols}); CREATE TEMP TABLE rm_next (${cols});`,
  )
  try {
    for (let i = 0; i < rowIds.length; i += 5000) {
      const chunk = rowIds.slice(i, i + 5000)
      db.prepare(
        `INSERT OR IGNORE INTO rm_prev ${pick(tableId)} WHERE t.id IN (${marks(chunk.length)})`,
      ).run(...chunk)
    }
    removed[tableId] = deleteCounted(
      db,
      tableId,
      `DELETE FROM "${tableId}" WHERE id IN (SELECT id FROM rm_prev)`,
      null,
    )
    for (const step of downstream) {
      validateTableId(step.id)
      const left = db.prepare('SELECT COUNT(*) AS n FROM rm_prev').get() as {
        n: number
      }
      if (!left.n) break
      if (tableExists(db, step.id)) {
        // `t` is the step's table (pick); rm_prev has a json column too.
        const match =
          step.type === 'sort'
            ? 't.JSON IN (SELECT p.json FROM rm_prev p)'
            : `CASE WHEN JSON_EXTRACT(t.JSON, '$._sourceId') IS NOT NULL
                 THEN CAST(JSON_EXTRACT(t.JSON, '$._sourceId') AS INTEGER) IN (SELECT p.id FROM rm_prev p)
               ELSE EXISTS (SELECT 1 FROM rm_prev p
                 WHERE p.path = JSON_EXTRACT(t.JSON, '$.path')
                   AND p.s IS JSON_EXTRACT(t.JSON, '$.startFrame')
                   AND p.e IS JSON_EXTRACT(t.JSON, '$.endFrame')) END`
        db.exec('DELETE FROM rm_next')
        db.prepare(`INSERT INTO rm_next ${pick(step.id)} WHERE ${match}`).run()
        removed[step.id] = deleteCounted(
          db,
          step.id,
          `DELETE FROM "${step.id}" WHERE id IN (SELECT id FROM rm_next)`,
          null,
        )
        db.exec(
          'DELETE FROM rm_prev; INSERT INTO rm_prev SELECT * FROM rm_next',
        )
      } else {
        // A step that never ran has nothing; the one after it read nothing.
        break
      }
    }
  } finally {
    drop()
  }
  return removed
}
