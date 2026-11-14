import fs from 'fs'
import Database from 'better-sqlite3'

let currentDb: Database.Database | null = null
let currentDbPath: string | null = null

export function getDb(dbPath: string): Database.Database {
  if (currentDb && currentDbPath === dbPath) return currentDb
  closeDb()
  const isNew = !fs.existsSync(dbPath)
  currentDb = new Database(dbPath)
  // New projects can be compacted in place, quickly and without extra disk
  // (projectCompaction.ts). Must be set before WAL mode and the first table.
  if (isNew) currentDb.pragma('auto_vacuum = INCREMENTAL')
  currentDb.pragma('journal_mode = WAL')
  currentDb.pragma('busy_timeout = 5000')
  currentDbPath = dbPath
  return currentDb
}

export function closeDb(): void {
  if (currentDb) {
    try {
      currentDb.pragma('wal_checkpoint(TRUNCATE)')
    } catch (_) {
      // empty
    }
    try {
      currentDb.close()
    } catch (_) {
      // empty
    }
    currentDb = null
    currentDbPath = null
    // Clear schema cache when DB is closed
    if (onCloseCallback) onCloseCallback()
  }
}

let onCloseCallback: (() => void) | null = null
export function setOnCloseCallback(cb: () => void) {
  onCloseCallback = cb
}
