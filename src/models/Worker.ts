import { WorkerMessage, FilesTableRow, FilterTableRow } from 'constants/types'
import { parentPort, workerData } from 'worker_threads'
import Database from 'better-sqlite3'

import methods from './methods'
import { getSortOrderExpr } from './methods/sort'

// --- Worker configuration constants ---
// Max errors to report back to main thread per worker (avoids flooding IPC)
const MAX_ERRORS = 5
// Rows to load from DB at once for parser methods (balances memory vs DB round-trips)
const PARSER_LOAD_CHUNK = 5000
// Rows to process at once for non-parser filters (prevents OOM on 6M+ row tables)
const FILTER_CHUNK_SIZE = 5000
// Rows per INSERT for sort (prevents OOM on large ORDER BY operations)
const SORT_CHUNK_SIZE = 50000
// Slow I/O filters process 1 item per chunk (each opens .slp file)
const SLOW_FILTER_CHUNK_SIZE = 1
// Batch size for lastFrame backfill updates during parser
const LASTFRAME_FLUSH_SIZE = 500
// Progress throttle for parser (ms between IPC progress messages)
const PROGRESS_THROTTLE_MS = 200

const METHODS_WITH_EMITTER = new Set([
  'comboFilter',
  'custom',
  'edgeguard',
  'zeroToDeaths',
  'files',
  'actionStateFilter',
  'afkDetection',
])

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

  try {
    // Sort is handled entirely in SQLite — chunked to avoid OOM on large datasets
    if (type === 'sort') {
      const { sortFunction, reverse } = params
      const orderExpr = getSortOrderExpr(sortFunction, reverse)
      if (!orderExpr) {
        postMessage({
          type: 'error',
          message: `Unknown sort function: ${sortFunction}`,
          filterType: type,
        })
        postMessage({ type: 'done', results: 0 })
        return
      }
      try {
        const total = slice.top - slice.bottom + 1
        let inserted = 0

        const sortTransaction = db.transaction(() => {
          for (
            let offset = slice.bottom;
            offset <= slice.top;
            offset += SORT_CHUNK_SIZE
          ) {
            const chunkEnd = Math.min(offset + SORT_CHUNK_SIZE - 1, slice.top)
            db.prepare(
              `INSERT INTO "${nextTableId}" (JSON) ` +
                `SELECT JSON FROM "${prevTableId}" ` +
                `WHERE id >= ? AND id <= ? ` +
                `ORDER BY ${orderExpr}`,
            ).run(offset, chunkEnd)
            inserted += chunkEnd - offset + 1
            postMessage({
              type: 'progress',
              current: inserted,
              total,
            })
          }
        })
        sortTransaction()

        const row = db
          .prepare(`SELECT COUNT(*) as cnt FROM "${nextTableId}"`)
          .get() as { cnt: number }
        postMessage({ type: 'done', results: row.cnt })
      } catch (err: unknown) {
        const errMsg = (err as Error)?.message || String(err)
        postMessage({
          type: 'error',
          message: errMsg,
          filterType: type,
        })
        postMessage({ type: 'done', results: 0 })
      }
      return
    }

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
    const insertBatch = db.transaction((items: Record<string, unknown>[]) => {
      for (const item of items) {
        stmt.run(JSON.stringify(item))
      }
    })

    let errorCount = 0
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

    if (type === 'slpParser') {
      // Parser methods read .slp files from disk (slow) — stream from DB
      // in chunks so we don't load 100K+ rows into memory before starting
      const total = slice.top - slice.bottom + 1

      // Flush size: balance between SQLite transaction overhead and result
      // freshness. Downstream filters query this table mid-run, so results
      // need to be committed frequently. A 500-row transaction takes ~5ms.
      const parserFlushSize = total < 1000 ? 100 : 500

      let totalInserted = 0
      let buffer: Record<string, unknown>[] = []
      let processed = 0
      let skippedCount = 0
      let lastProgressTime = 0
      let currentBottom = slice.bottom

      // Collect lastFrame updates for files with stripped metadata
      const lastFrameUpdates: { path: string; lastFrame: number }[] = []
      const updateLastFrameStmt = db.prepare(
        'UPDATE files SET lastFrame = ? WHERE path = ? AND (lastFrame IS NULL OR lastFrame <= 0 OR lastFrame = -123)',
      )
      const flushLastFrameUpdates = db.transaction(() => {
        for (const u of lastFrameUpdates) {
          updateLastFrameStmt.run(u.lastFrame, u.path)
        }
        lastFrameUpdates.length = 0
      })

      while (currentBottom <= slice.top) {
        const currentTop = Math.min(
          currentBottom + PARSER_LOAD_CHUNK - 1,
          slice.top,
        )
        const chunkRows = getRows(db, prevTableId, {
          bottom: currentBottom,
          top: currentTop,
        })
        const chunk = parseRows(prevTableId, chunkRows)

        for (const item of chunk) {
          const now = Date.now()
          if (now - lastProgressTime >= PROGRESS_THROTTLE_MS) {
            postMessage({
              type: 'progress',
              current: processed,
              total,
              results: totalInserted + buffer.length,
              skipped: skippedCount,
            })
            lastProgressTime = now
          }
          if (skipSet && item._sourceId && skipSet.has(item._sourceId)) {
            processed++
            skippedCount++
            continue
          }
          try {
            const res = method(item, params)
            if (res && typeof res === 'object' && 'combos' in res) {
              // slpParser returns { combos, lastFrame }
              const { combos, lastFrame } = res as {
                combos: Record<string, unknown>[]
                lastFrame?: number
              }
              if (Array.isArray(combos)) {
                for (let i = 0; i < combos.length; i += 1) {
                  if (combos[i]) buffer.push(combos[i])
                }
              }
              if (lastFrame && lastFrame > 0 && typeof item.path === 'string') {
                lastFrameUpdates.push({
                  path: item.path,
                  lastFrame,
                })
              }
            } else if (Array.isArray(res)) {
              for (let i = 0; i < res.length; i += 1) {
                if (res[i]) buffer.push(res[i])
              }
            }
          } catch (err: unknown) {
            sendError((err as Error)?.message || String(err), processed)
          }
          // First flush at 100 for quick partial results, then adaptive size
          const flushAt = totalInserted === 0 ? 100 : parserFlushSize
          if (buffer.length >= flushAt) {
            insertBatch(buffer)
            totalInserted += buffer.length
            buffer = []
          }
          if (lastFrameUpdates.length >= LASTFRAME_FLUSH_SIZE) {
            flushLastFrameUpdates()
          }
          processed++
        }

        currentBottom = currentTop + 1
      }
      if (buffer.length > 0) {
        insertBatch(buffer)
        totalInserted += buffer.length
      }
      if (lastFrameUpdates.length > 0) {
        flushLastFrameUpdates()
      }
      postMessage({
        type: 'progress',
        current: processed,
        total,
        results: totalInserted,
        skipped: skippedCount,
      })
      postMessage({ type: 'done', results: totalInserted })
    } else {
      // Non-parser filters: process in chunks to avoid OOM
      const total = slice.top - slice.bottom + 1
      let totalInserted = 0
      let processed = 0
      let skippedCount = 0
      let currentBottom = slice.bottom

      // Slow I/O filters (open .slp files per item) use chunk size 1 so
      // results update after every file; fast filters use large chunks.
      const slowTypes = new Set([
        'actionStateFilter',
        'reverse',
        'removeStarKOFrames',
        'koDirection',
        'edgeguard',
        'afkDetection',
      ])
      const isSlow = slowTypes.has(type)
      const effectiveChunkSize = isSlow
        ? SLOW_FILTER_CHUNK_SIZE
        : FILTER_CHUNK_SIZE

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
          skippedCount += chunk.length
          postMessage({
            type: 'progress',
            current: processed,
            total,
            results: totalInserted,
            skipped: skippedCount,
          })
          currentBottom = currentTop + 1
          continue
        }

        const chunkEmitter = () => {}

        let results: Record<string, unknown>[] = []
        try {
          if (METHODS_WITH_EMITTER.has(type)) {
            const res = method(chunk, params, chunkEmitter)
            if (Array.isArray(res)) {
              results = res as Record<string, unknown>[]
            } else if (res && 'clips' in res && Array.isArray(res.clips)) {
              results = res.clips as Record<string, unknown>[]
              if (res.logs?.length) {
                postMessage({ type: 'logs', logs: res.logs } as any)
              }
            }
          } else {
            const res = method(chunk, params)
            if (Array.isArray(res)) results = res as Record<string, unknown>[]
          }
        } catch (err: unknown) {
          const errObj = err as { message?: string; logs?: string[] }
          sendError(errObj?.message || String(err), processed)
          if (errObj.logs?.length) {
            postMessage({ type: 'logs', logs: errObj.logs } as any)
          }
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
          skipped: skippedCount,
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
} catch (error: unknown) {
  console.error('Worker failed:', error)
  const type = workerData?.type || 'unknown'
  postMessage({
    type: 'error',
    message: (error as Error)?.message || String(error),
    filterType: type,
  })
  postMessage({ type: 'done', results: 0 })
}

function getRows(
  db: Database.Database,
  tableId: string,
  slice: { bottom: number; top: number },
): (FilesTableRow | FilterTableRow)[] {
  return db
    .prepare(`SELECT * FROM "${tableId}" WHERE id >= ? AND id <= ? ORDER BY id`)
    .all(slice.bottom, slice.top) as (FilesTableRow | FilterTableRow)[]
}

function parseRows(
  tableId: string,
  rows: (FilesTableRow | FilterTableRow)[],
): Record<string, any>[] {
  const results: Record<string, any>[] = []
  if (!rows || rows.length === 0) return results

  if (tableId === 'files') {
    rows.forEach((rawRow) => {
      const row = rawRow as FilesTableRow
      if (!row.id) return
      let players: any[] = []
      try {
        players = row.players ? JSON.parse(row.players) : []
      } catch {
        // corrupt players JSON — use empty array
      }
      results.push({
        id: row.id,
        _sourceId: row.id,
        path: row.path,
        players,
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
    let parseErrors = 0
    rows.forEach((rawRow) => {
      const row = rawRow as FilterTableRow
      if (!row.JSON) return
      try {
        const obj = JSON.parse(row.JSON)
        obj._sourceId = row.id
        results.push(obj)
      } catch {
        parseErrors++
      }
    })
    if (parseErrors > 0)
      console.warn(`Skipped ${parseErrors} rows with corrupt JSON`)
  }

  return results
}
