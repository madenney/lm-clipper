import { WorkerMessage } from 'constants/types'
import { parentPort, workerData } from 'worker_threads'
import Database from 'better-sqlite3'

import methods from './methods'

function postMessage(message: WorkerMessage) {
  parentPort?.postMessage(message)
}

function run() {
  const {
    dbPath,
    prevTableId,
    nextTableId,
    type,
    slice,
    params,
    skipSourceIds,
  } = workerData
  const skipSet: Set<number> | null =
    skipSourceIds && skipSourceIds.length > 0
      ? new Set<number>(skipSourceIds)
      : null

  const db = new Database(dbPath, { readonly: false })
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')

  const _FLUSH_SIZE = 100 // default for non-parser paths

  try {
    const method = methods[type]
    if (!method) {
      postMessage({
        type: 'error',
        message: `Unknown filter method: ${type}`,
        filterType: type,
      })
      postMessage({ type: 'done', results: 0 })
      return
    }

    const stmt = db.prepare(`INSERT INTO "${nextTableId}" (JSON) VALUES (?)`)
    const insertBatch = db.transaction((items: any[]) => {
      for (const item of items) {
        stmt.run(JSON.stringify(item))
      }
    })

    let errorCount = 0
    const MAX_ERRORS = 5
    const sendError = (msg: string, itemIndex?: number) => {
      errorCount++
      if (errorCount <= MAX_ERRORS) {
        postMessage({
          type: 'error',
          message: msg,
          filterType: type,
          itemIndex,
        })
      }
    }

    // Sort loads all rows upfront; parsers and other filters stream in chunks
    const prevResults =
      type === 'sort'
        ? parseRows(prevTableId, getRows(db, prevTableId, slice))
        : []

    if (type === 'slpParser') {
      // Parser methods read .slp files from disk (slow) — stream from DB
      // in chunks so we don't load 100K+ rows into memory before starting
      const total = slice.top - slice.bottom + 1
      const LOAD_CHUNK = 5000

      // Adaptive flush size: small runs flush often for UI responsiveness,
      // large runs flush less often to minimize SQLite transaction overhead.
      // First flush always at 100 so partial results are available quickly.
      const parserFlushSize =
        total < 1000 ? 100 : total < 10000 ? 500 : total < 100000 ? 2000 : 5000

      let totalInserted = 0
      let buffer: any[] = []
      let processed = 0
      let lastProgressTime = 0
      let currentBottom = slice.bottom

      while (currentBottom <= slice.top) {
        const currentTop = Math.min(currentBottom + LOAD_CHUNK - 1, slice.top)
        const chunkRows = getRows(db, prevTableId, {
          bottom: currentBottom,
          top: currentTop,
        })
        const chunk = parseRows(prevTableId, chunkRows)

        for (const item of chunk) {
          const now = Date.now()
          if (now - lastProgressTime >= 200) {
            postMessage({
              type: 'progress',
              current: processed,
              total,
              results: totalInserted,
            })
            lastProgressTime = now
          }
          if (skipSet && item._sourceId && skipSet.has(item._sourceId)) {
            processed++
            continue
          }
          try {
            const res = method(item, params)
            if (Array.isArray(res)) {
              for (let i = 0; i < res.length; i += 1) {
                if (res[i]) buffer.push(res[i])
              }
            }
          } catch (err: any) {
            sendError(err?.message || String(err), processed)
          }
          // First flush at 100 for quick partial results, then adaptive size
          const flushAt = totalInserted === 0 ? 100 : parserFlushSize
          if (buffer.length >= flushAt) {
            insertBatch(buffer)
            totalInserted += buffer.length
            buffer = []
          }
          processed++
        }

        currentBottom = currentTop + 1
      }
      if (buffer.length > 0) {
        insertBatch(buffer)
        totalInserted += buffer.length
      }
      postMessage({
        type: 'progress',
        current: processed,
        total,
        results: totalInserted,
      })
      postMessage({ type: 'done', results: totalInserted })
    } else if (type === 'sort') {
      // Sort needs all data in memory — keep as single batch
      const progressEmitter = createProgressEmitter()
      let results: any[] = []
      try {
        if (method.length >= 3) {
          const res = method(prevResults, params, progressEmitter)
          if (Array.isArray(res)) results = res
        } else {
          const res = method(prevResults, params)
          if (Array.isArray(res)) results = res
        }
      } catch (err: any) {
        sendError(err?.message || String(err))
      }
      results = results.filter(Boolean)
      insertBatch(results)
      postMessage({ type: 'done', results: results.length })
    } else {
      // Non-parser filters: process in chunks to avoid OOM
      const CHUNK_SIZE = 5000
      const total = slice.top - slice.bottom + 1
      let totalInserted = 0
      let processed = 0
      let currentBottom = slice.bottom

      // Slow I/O filters (open .slp files per item) use chunk size 1 so
      // results update after every file; fast filters use large chunks.
      const slowTypes = new Set([
        'actionStateFilter',
        'reverse',
        'removeStarKOFrames',
        'edgeguard',
      ])
      const isSlow = slowTypes.has(type)
      const effectiveChunkSize = isSlow ? 1 : CHUNK_SIZE

      while (currentBottom <= slice.top) {
        const currentTop = Math.min(
          currentBottom + effectiveChunkSize - 1,
          slice.top,
        )
        const chunkRows = getRows(db, prevTableId, {
          bottom: currentBottom,
          top: currentTop,
        })
        const chunk = parseRows(prevTableId, chunkRows)

        if (
          skipSet &&
          chunk.length > 0 &&
          chunk[0]._sourceId &&
          skipSet.has(chunk[0]._sourceId)
        ) {
          processed += chunk.length
          postMessage({
            type: 'progress',
            current: processed,
            total,
            results: totalInserted,
          })
          currentBottom = currentTop + 1
          continue
        }

        const chunkEmitter = () => {}

        let results: any[] = []
        try {
          if (method.length >= 3) {
            const res = method(chunk, params, chunkEmitter)
            if (Array.isArray(res)) results = res
          } else {
            const res = method(chunk, params)
            if (Array.isArray(res)) results = res
          }
        } catch (err: any) {
          sendError(err?.message || String(err), processed)
        }

        results = results.filter(Boolean)
        if (results.length > 0) {
          insertBatch(results)
          totalInserted += results.length
        }

        processed += chunk.length
        postMessage({
          type: 'progress',
          current: processed,
          total,
          results: totalInserted,
        })
        currentBottom = currentTop + 1
      }

      postMessage({ type: 'done', results: totalInserted })
    }
  } finally {
    try {
      db.close()
    } catch (_) {
      // empty
    }
  }
}

try {
  run()
} catch (error: any) {
  console.log('Worker failed:', error)
  const type = workerData?.type || 'unknown'
  postMessage({
    type: 'error',
    message: error?.message || String(error),
    filterType: type,
  })
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
  slice: { bottom: number; top: number },
) {
  return db
    .prepare(`SELECT * FROM "${tableId}" WHERE id >= ? AND id <= ? ORDER BY id`)
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
        _sourceId: row.id,
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
        obj._sourceId = row.id
        results.push(obj)
      } catch (error) {
        console.log('Error parsing row JSON:', error)
      }
    })
  }

  return results
}
