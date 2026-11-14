import type Database from 'better-sqlite3'

/**
 * Manual clip order. Dragging clips in the tray writes `sort_order` on that
 * filter's table, and the tray shows rows by `COALESCE(sort_order, id)`. A
 * filter run on such a table copies each input row's place into its own rows'
 * `sort_order`, so the next filter keeps the order the user chose.
 *
 * A manually ordered table has the index below, matching the tray's ORDER BY.
 * Its existence is the marker (DbWorker.itemsOrderBy uses it the same way), so
 * a run can tell in O(1) instead of scanning millions of rows for sort_order.
 */
const indexName = (tableId: string) => `idx_${tableId}_sortorder`

export function hasManualOrder(db: Database.Database, tableId: string) {
  return !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?")
    .get(indexName(tableId))
}

export function markManualOrder(db: Database.Database, tableId: string) {
  const cols = (
    db.prepare(`PRAGMA table_info("${tableId}")`).all() as { name: string }[]
  ).map((c) => c.name)
  if (!cols.includes('sort_order')) {
    try {
      db.exec(
        `ALTER TABLE "${tableId}" ADD COLUMN sort_order INTEGER DEFAULT NULL`,
      )
    } catch (e) {
      // Another filter worker added it first.
      if (!/duplicate column name/i.test((e as Error)?.message || '')) throw e
    }
  }
  db.exec(
    `CREATE INDEX IF NOT EXISTS "${indexName(tableId)}" ON "${tableId}"(COALESCE(sort_order, id), id)`,
  )
}
