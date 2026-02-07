import Database from 'better-sqlite3'

let currentDb: Database.Database | null = null
let currentDbPath: string | null = null

export function getDb(dbPath: string): Database.Database {
  if (currentDb && currentDbPath === dbPath) return currentDb
  closeDb()
  currentDb = new Database(dbPath)
  currentDb.pragma('journal_mode = WAL')
  currentDb.pragma('busy_timeout = 5000')
  currentDbPath = dbPath
  return currentDb
}

export function closeDb(): void {
  if (currentDb) {
    try { currentDb.pragma('wal_checkpoint(TRUNCATE)') } catch (_) {}
    try { currentDb.close() } catch (_) {}
    currentDb = null
    currentDbPath = null
  }
}
