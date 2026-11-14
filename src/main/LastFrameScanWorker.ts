/**
 * Fills in the length of games imported before Clipper read it from the
 * replay itself: anonymized replays (e.g. ranked) have no metadata, so older
 * imports stored lastFrame = -123 and the footer, the length sort and full-game
 * recordings had nothing to go on. Reads the last frame from the end of each
 * such replay (lib/lastFrame.ts: a few bytes, no frame parsing) and writes it.
 *
 * Then the results tables: rows copied from those games (the Game Filter's
 * results and the steps after it) still say -123, so they get the new length
 * too, a slice of rows at a time.
 *
 * Low priority and resumable like CpuScanWorker: a batch at a time with a rest
 * after each one; rows already done aren't picked again, so the next open
 * continues where this one stopped. controller.ts starts it with the CPU check
 * and pauses it while an import or filter runs.
 *
 * workerData: { dbPath, batchSize?, restMs?, sliceSize? }
 * In:  { type: 'pause' } | { type: 'resume' } | { type: 'stop' }
 * Out: { type: 'progress' | 'done', ...LastFrameScanCounts } | { type: 'error', message }
 *
 * Missing replays are passed over (left -123, tried again next time); a replay
 * that opens but has no frames to read gets 0 (unknown for good).
 */
import { parentPort, workerData } from 'worker_threads'
import fs from 'fs'
import path from 'path'
import Database from 'better-sqlite3'
import {
  type LastFrameScanCounts,
  readLastFrame,
  UNKNOWN_LAST_FRAME,
  UNREADABLE_LAST_FRAME,
} from '../lib/lastFrame'

const {
  dbPath,
  batchSize = 200,
  restMs = 250,
  sliceSize = 5000,
} = workerData as {
  dbPath: string
  batchSize?: number
  restMs?: number
  sliceSize?: number
}

const PENDING = `lastFrame = ${UNKNOWN_LAST_FRAME}`
// This many replays in a row out of reach: the drive or share is gone.
const GIVE_UP_AFTER = 2000
// Set while results rows may still say -123 for games that have a length
// now, so a run stopped after the files were done still fixes the results
// next time. One row; dropped once the results are done.
const MARKER = 'lastframe_results_pending'

let paused = false
let stopped = false
parentPort?.on('message', (m: { type?: string }) => {
  if (m?.type === 'pause') paused = true
  else if (m?.type === 'resume') paused = false
  else if (m?.type === 'stop') stopped = true
})

const sleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

/** Folders known to be gone this run: their replays aren't tried one by one. */
const goneFolders = new Set<string>()

/** The replay's last frame, null when it has none, or 'missing'. */
function lastFrameOf(file: string): number | null | 'missing' {
  const dir = path.dirname(file)
  if (goneFolders.has(dir)) return 'missing'
  if (!fs.existsSync(file)) {
    if (!fs.existsSync(dir)) goneFolders.add(dir)
    return 'missing'
  }
  try {
    return readLastFrame(file)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code
    // Gone or unreachable between the check and the read.
    if (code === 'ENOENT' || code === 'EACCES' || code === 'EIO')
      return 'missing'
    return null
  }
}

function isBusy(error: unknown) {
  const code = (error as { code?: string })?.code || ''
  return code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED')
}

/** Run a write, waiting out a busy project (an import or filter writing). */
async function write<T>(fn: () => T): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return fn()
    } catch (error) {
      if (!isBusy(error) || attempt >= 5 || stopped) throw error
      await sleep(2000)
    }
  }
}

async function waitWhilePaused() {
  while (paused && !stopped) await sleep(500)
}

/** The results tables (as MissingCheckWorker finds them). */
function resultsTables(db: Database.Database): string[] {
  const names = (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'filter\\_%' ESCAPE '\\' AND name <> 'filter_runs'",
      )
      .all() as { name: string }[]
  ).map((r) => r.name)
  return names.filter((name) => {
    if (name.includes('"')) return false
    const cols = (
      db.prepare(`PRAGMA table_info("${name}")`).all() as { name: string }[]
    ).map((c) => c.name)
    return cols.includes('JSON') && cols.includes('id')
  })
}

function resultsPending(db: Database.Database) {
  return !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?")
    .get(MARKER)
}

/** Give rows copied from repaired games their length, a slice at a time. */
async function repairResults(
  db: Database.Database,
  counts: LastFrameScanCounts,
) {
  // The game's length from the files table, when it's known now.
  const known = (t: string) =>
    `(SELECT lastFrame FROM files WHERE path = json_extract("${t}".JSON, '$.path') AND lastFrame > 0 LIMIT 1)`
  for (const t of resultsTables(db)) {
    const { lo, hi } = db
      .prepare(`SELECT MIN(id) AS lo, MAX(id) AS hi FROM "${t}"`)
      .get() as { lo: number | null; hi: number | null }
    if (lo === null || hi === null) continue
    const update = db.prepare(
      `UPDATE "${t}" SET JSON = json_set(JSON,
         '$.lastFrame', ${known(t)},
         '$.endFrame', CASE WHEN COALESCE(json_extract(JSON, '$.endFrame'), 0) <= 0
           THEN ${known(t)} ELSE json_extract(JSON, '$.endFrame') END)
       WHERE id >= ? AND id < ?
         AND json_extract(JSON, '$.lastFrame') = ${UNKNOWN_LAST_FRAME}
         AND ${known(t)} IS NOT NULL`,
    )
    for (let from = lo; from <= hi && !stopped; from += sliceSize) {
      await waitWhilePaused()
      if (stopped) break
      const started = Date.now()
      const { changes } = await write(() => update.run(from, from + sliceSize))
      counts.resultsRows += changes
      await sleep(Math.max(restMs, Date.now() - started))
    }
    if (stopped) break
  }
  if (!stopped) await write(() => db.exec(`DROP TABLE IF EXISTS ${MARKER}`))
}

async function run(): Promise<LastFrameScanCounts> {
  const db = new Database(dbPath, { fileMustExist: true })
  db.pragma('busy_timeout = 10000')
  try {
    const cols = (
      db.prepare('PRAGMA table_info(files)').all() as { name: string }[]
    ).map((c) => c.name)
    // Games the missing-replays check found gone aren't tried.
    const where = cols.includes('missing')
      ? `${PENDING} AND missing = 0`
      : PENDING
    const counts: LastFrameScanCounts = {
      total: (
        db.prepare(`SELECT COUNT(*) AS n FROM files WHERE ${where}`).get() as {
          n: number
        }
      ).n,
      checked: 0,
      repaired: 0,
      missing: 0,
      unreadable: 0,
      resultsRows: 0,
    }
    parentPort?.postMessage({ type: 'progress', ...counts })
    if (counts.total === 0) {
      // A run stopped while the results were being fixed: finish them.
      if (resultsPending(db)) await repairResults(db, counts)
      return counts
    }

    const page = db.prepare(
      `SELECT id, path FROM files WHERE id > ? AND ${where} ORDER BY id LIMIT ?`,
    )
    // Only if the row still has no length.
    const setLength = db.prepare(
      `UPDATE files SET lastFrame = ? WHERE id = ? AND ${PENDING}`,
    )
    let lastId = 0
    let outOfReach = 0
    while (!stopped) {
      await waitWhilePaused()
      if (stopped) break
      const started = Date.now()
      const rows = page.all(lastId, batchSize) as {
        id: number
        path: string | null
      }[]
      if (rows.length === 0) break
      const updates: { id: number; lastFrame: number }[] = []
      for (const row of rows) {
        const found = row.path ? lastFrameOf(row.path) : 'missing'
        if (found === 'missing') {
          counts.missing += 1
          outOfReach += 1
          continue
        }
        outOfReach = 0
        if (found === null) {
          counts.unreadable += 1
          updates.push({ id: row.id, lastFrame: UNREADABLE_LAST_FRAME })
        } else {
          counts.repaired += 1
          updates.push({ id: row.id, lastFrame: found })
        }
      }
      await write(() =>
        db.transaction(() => {
          if (updates.some((u) => u.lastFrame > 0))
            db.exec(`CREATE TABLE IF NOT EXISTS ${MARKER} (at INTEGER)`)
          for (const u of updates) setLength.run(u.lastFrame, u.id)
        })(),
      )
      lastId = rows[rows.length - 1].id
      counts.checked += rows.length
      parentPort?.postMessage({ type: 'progress', ...counts })
      if (outOfReach >= GIVE_UP_AFTER) {
        counts.unreachable = true
        break
      }
      // Rest at least as long as the batch took: low priority.
      await sleep(Math.max(restMs, Date.now() - started))
    }
    if (resultsPending(db) && !stopped) {
      await repairResults(db, counts)
      parentPort?.postMessage({ type: 'progress', ...counts })
    }
    return counts
  } finally {
    db.close()
  }
}

run()
  .then((counts) =>
    parentPort?.postMessage({ type: 'done', ...counts, stopped }),
  )
  .catch((error) =>
    parentPort?.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    }),
  )
