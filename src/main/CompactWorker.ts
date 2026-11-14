/**
 * Runs Compact Project's SQLite work off the main thread (projectCompaction.ts).
 * workerData: { dbPath, mode: 'info' | 'incremental' | 'copy', tempPath? }.
 * Replies { type: 'done', info? } or { type: 'error', message }.
 */
import { parentPort, workerData } from 'worker_threads'
import fs from 'fs'
import Database from 'better-sqlite3'
import type { SpaceInfo } from './projectCompaction'

const { dbPath, mode, tempPath } = workerData as {
  dbPath: string
  mode: 'info' | 'incremental' | 'copy' | 'games'
  tempPath?: string
}

function spaceInfo(db: Database.Database): SpaceInfo {
  return {
    pageSize: db.pragma('page_size', { simple: true }) as number,
    pageCount: db.pragma('page_count', { simple: true }) as number,
    freePages: db.pragma('freelist_count', { simple: true }) as number,
    autoVacuum: db.pragma('auto_vacuum', { simple: true }) as number,
  }
}

try {
  const db = new Database(dbPath, { fileMustExist: true })
  try {
    db.pragma('busy_timeout = 5000')
    if (mode === 'games') {
      // How many games a project holds (the old-Untitled cleanup offer).
      const row = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='files'",
        )
        .get()
        ? (db.prepare('SELECT COUNT(*) AS c FROM files').get() as { c: number })
        : { c: 0 }
      parentPort?.postMessage({
        type: 'done',
        info: { ...spaceInfo(db), games: row.c },
      })
    } else if (mode === 'info') {
      parentPort?.postMessage({ type: 'done', info: spaceInfo(db) })
    } else if (mode === 'incremental') {
      db.pragma('incremental_vacuum')
      db.pragma('wal_checkpoint(TRUNCATE)')
      parentPort?.postMessage({ type: 'done', info: spaceInfo(db) })
    } else {
      if (!tempPath) throw new Error('No temp path for the compacted copy.')
      fs.rmSync(tempPath, { force: true })
      // Fold the WAL in first, so the copy is the whole project.
      db.pragma('wal_checkpoint(TRUNCATE)')
      // Read by VACUUM INTO: the copy gets incremental auto-vacuum, so later
      // compactions of it happen in place.
      db.pragma('auto_vacuum = INCREMENTAL')
      db.prepare('VACUUM INTO ?').run(tempPath)
      const copy = new Database(tempPath, { fileMustExist: true })
      try {
        const ok = copy.pragma('quick_check(1)', { simple: true })
        if (ok !== 'ok')
          throw new Error(`The compacted copy failed its check (${ok}).`)
        parentPort?.postMessage({ type: 'done', info: spaceInfo(copy) })
      } finally {
        copy.close()
      }
    }
  } finally {
    db.close()
  }
} catch (error) {
  parentPort?.postMessage({
    type: 'error',
    message: error instanceof Error ? error.message : String(error),
  })
}
