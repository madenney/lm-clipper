import { WorkerMessage } from 'constants/types'
import { parentPort, workerData } from 'worker_threads'
import Database from 'better-sqlite3'

import methods from './methods'

function postMessage(message: WorkerMessage) {
  parentPort?.postMessage(message)
}

function run() {
  const { dbPath, prevTableId, nextTableId, type, slice, params } =
    workerData

  const db = new Database(dbPath, { readonly: false })
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')

  const FLUSH_SIZE = 100

  try {
    const rows = getRows(db, prevTableId, slice)
    const prevResults = parseRows(prevTableId, rows)

    const method = methods[type]
    if (!method) {
      postMessage({ type: 'done', results: 0 })
      return
    }

    const stmt = db.prepare(`INSERT INTO "${nextTableId}" (JSON) VALUES (?)`)
    const insertBatch = db.transaction((items: any[]) => {
      for (const item of items) {
        stmt.run(JSON.stringify(item))
      }
    })

    if (type === 'slpParser' || type === 'slpParser2') {
      // Parser methods read .slp files from disk (slow) — flush incrementally
      // so partial results are visible via the View button
      let totalInserted = 0
      let buffer: any[] = []
      const noopEmitter = () => {}
      const total = prevResults.length
      prevResults.forEach((item, index) => {
        postMessage({ type: 'progress', current: index, total })
        // slpParser2 takes (item, params); slpParser takes ([item], params, emitter)
        const res = type === 'slpParser2'
          ? method(item, params)
          : method([item], params, noopEmitter)
        if (Array.isArray(res)) {
          for (let i = 0; i < res.length; i += 1) {
            if (res[i]) buffer.push(res[i])
          }
        }
        if (buffer.length >= FLUSH_SIZE) {
          insertBatch(buffer)
          totalInserted += buffer.length
          buffer = []
        }
      })
      if (buffer.length > 0) {
        insertBatch(buffer)
        totalInserted += buffer.length
      }
      postMessage({ type: 'done', results: totalInserted })
    } else {
      // Non-parser filters: compute all results first, then single transaction insert
      let results: any[] = []
      const progressEmitter = createProgressEmitter()

      if (method.length >= 3) {
        const res = method(prevResults, params, progressEmitter)
        if (Array.isArray(res)) results = res
      } else {
        const res = method(prevResults, params)
        if (Array.isArray(res)) results = res
      }

      results = results.filter(Boolean)
      insertBatch(results)
      postMessage({ type: 'done', results: results.length })
    }
  } finally {
    try { db.close() } catch (_) {}
  }
}

try {
  run()
} catch (error) {
  console.log('Worker failed:', error)
  postMessage({ type: 'done', results: 0 })
}

function createProgressEmitter() {
  let lastSent = -1
  return ({ current, total }: { current: number; total: number }) => {
    const adjusted = Math.min(total, current + 1)
    if (adjusted !== lastSent) {
      lastSent = adjusted
      postMessage({ type: 'progress', current: adjusted, total })
    }
  }
}

function getRows(
  db: Database.Database,
  tableId: string,
  slice: { bottom: number; top: number }
) {
  return db
    .prepare(
      `SELECT * FROM "${tableId}" WHERE id >= ? AND id <= ? ORDER BY id`
    )
    .all(slice.bottom, slice.top)
}

function parseRows(tableId: string, rows: any[]) {
  const results: any[] = []
  if (!rows || rows.length === 0) return results

  if (tableId === 'files') {
    rows.forEach((row) => {
      if (!row.id) return
      results.push({
        id: row.id,
        path: row.path,
        players: row.players ? JSON.parse(row.players) : [],
        winner: row.winner,
        stage: row.stage,
        startedAt: row.startedAt,
        lastFrame: row.lastFrame,
        isValid: true,
        isProcessed: row.isProcessed === 1,
        info: row.info || '',
        startFrame: -123,
        endFrame: row.lastFrame,
      })
    })
  } else {
    rows.forEach((row) => {
      if (!row.JSON) return
      try {
        const obj = JSON.parse(row.JSON)
        results.push(obj)
      } catch (error) {
        console.log('Error parsing row JSON:', error)
      }
    })
  }

  return results
}
