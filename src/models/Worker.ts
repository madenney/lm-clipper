import { WorkerMessage, FilesTableRow, FilterTableRow } from 'constants/types'
import { parentPort, workerData } from 'worker_threads'
import { existsSync } from 'fs'
import Database from 'better-sqlite3'
import { parseSemicolonParam } from '../lib/filterHelpers'

import methods from './methods'
import { getSortOrderExpr } from './methods/sort'
import { GAME_START_FRAME } from '../constants/frames'
import {
  PARSER_FILTERS,
  REPLAY_READING_FILTERS,
  traitsOf,
} from './filterTraits'
import { hasManualOrder, markManualOrder } from '../main/manualOrder'
import { validateTableId } from '../main/tableId'
import { DetectionCache } from './detectionCache'

// --- Worker configuration constants ---
// Max errors to report back to main thread per worker (avoids flooding IPC)
const MAX_ERRORS = 5
// Rows to load from DB at once for parser methods (balances memory vs DB round-trips)
const PARSER_LOAD_CHUNK = 5000
// Rows to process at once for non-parser filters (prevents OOM on 6M+ row tables)
const FILTER_CHUNK_SIZE = 5000

// Defined before run() below: the worker starts running as soon as this file loads.
/** Player lookups a results table can carry (built for huge tables that never
 *  change): index name suffix → the clip field it covers. */
export const PLAYER_INDEXES = {
  comboerTag: ['comboer_name', '$.comboer.displayName'],
  comboeeTag: ['comboee_name', '$.comboee.displayName'],
  comboerCC: ['comboer_code', '$.comboer.connectCode'],
  comboeeCC: ['comboee_code', '$.comboee.connectCode'],
} as const

/** The expression a player index is built on (must match exactly for SQLite to use it). */
export const playerIndexExpr = (field: string) =>
  `lower(json_extract(JSON, '${field}'))`

// Slow I/O filters process 1 item per chunk (each opens .slp file)
const SLOW_FILTER_CHUNK_SIZE = 1
// Batch size for lastFrame backfill updates during parser
const LASTFRAME_FLUSH_SIZE = 500
// Progress throttle for parser (ms between IPC progress messages)
const PROGRESS_THROTTLE_MS = 200

// Parser methods read .slp files one at a time and return { combos, lastFrame }
// (not an array). They share the streaming + lastFrame-backfill path below.
const PARSER_METHOD_TYPES = PARSER_FILTERS

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
    libraryFolder,
  } = workerData
  // Table ids go into SQL as identifiers (launch review FLT-8 / SEC-4).
  validateTableId(prevTableId)
  validateTableId(nextTableId)
  const skipSet: Set<number> | null =
    skipSourceIds && skipSourceIds.length > 0
      ? new Set<number>(skipSourceIds)
      : null

  const db = new Database(dbPath, { readonly: false })
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')

  // Filter.ts hands out POSITIONS (rows 1..N of the input, in id order). Ids have
  // gaps once games or clips are removed, so read the ids actually at those
  // positions; slicing ids 1..COUNT(*) silently skipped the last rows.
  const sliceTotal = slice.top - slice.bottom + 1
  const idBounds = resolveIdBounds(db, prevTableId, slice)
  slice.bottom = idBounds.bottom
  slice.top = idBounds.top

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
        const total = sliceTotal

        // Single global ORDER BY. SQLite's sorter spills to temp storage
        // (temp_store=FILE) instead of holding every row in RAM, so this stays
        // memory-safe even on millions of rows — and, unlike the previous
        // per-50k-id-block approach, it produces a TRUE global ordering. The old
        // version sorted only WITHIN each 50k block and concatenated them, so any
        // dataset larger than one block came out only locally sorted (the real
        // top clip could be stuck behind the top of every later block).
        db.pragma('temp_store = FILE')
        postMessage({ type: 'progress', current: 0, total })
        db.prepare(
          `INSERT INTO "${nextTableId}" (JSON) ` +
            `SELECT src.JSON FROM "${prevTableId}" AS src ` +
            `WHERE src.id >= ? AND src.id <= ? ` +
            // Ties (the same start time for clips of one game, equal damage...)
            // keep the input's order, so two sorts of the same input agree.
            `ORDER BY ${orderExpr}, src.id`,
        ).run(slice.bottom, slice.top)
        postMessage({ type: 'progress', current: total, total })

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

    // Random sample: keep exactly `count` clips chosen uniformly at random.
    // Single-threaded (Filter.ts forces one worker) so this slice IS the whole
    // input. Uses reservoir sampling (Algorithm R) — one pass, memory bounded to
    // `count`, correct without knowing the total up front. Streams via parseRows
    // so it works identically on the files table and on filter output tables.
    if (type === 'randomSample') {
      const total = sliceTotal
      // Blank/invalid count = no limit (keep everything), matching the app's
      // other numeric fields — clearing the field shouldn't silently drop every
      // clip. An explicit 0 still means zero.
      const rawStr = params.count == null ? '' : String(params.count).trim()
      const raw = parseInt(rawStr, 10)
      const target = rawStr === '' || Number.isNaN(raw) || raw < 0 ? total : raw
      const stmt = db.prepare(`INSERT INTO "${nextTableId}" (JSON) VALUES (?)`)
      const insertBatch = db.transaction((items: Record<string, unknown>[]) => {
        for (const it of items) stmt.run(JSON.stringify(it))
      })

      if (target === 0 || total === 0) {
        postMessage({ type: 'done', results: 0 })
        return
      }

      postMessage({ type: 'progress', current: 0, total, results: 0 })

      // Keeping everything (count >= input, or blank): stream through in chunks
      // and insert as we go, so memory stays O(chunk) instead of holding the
      // whole input. No sampling needed.
      if (target >= total) {
        let inserted = 0
        let currentBottom = slice.bottom
        let lastProgressTime = 0
        while (currentBottom <= slice.top) {
          const currentTop = Math.min(
            currentBottom + FILTER_CHUNK_SIZE - 1,
            slice.top,
          )
          const chunk = parseRows(
            prevTableId,
            getRows(db, prevTableId, {
              bottom: currentBottom,
              top: currentTop,
            }),
          )
          if (chunk.length > 0) {
            insertBatch(chunk)
            inserted += chunk.length
          }
          const now = Date.now()
          if (now - lastProgressTime >= PROGRESS_THROTTLE_MS) {
            postMessage({
              type: 'progress',
              current: inserted,
              total,
              results: inserted,
            })
            lastProgressTime = now
          }
          currentBottom = currentTop + 1
        }
        postMessage({ type: 'done', results: inserted })
        return
      }

      // Reservoir sampling (Algorithm R): one pass, memory bounded to `target`.
      const reservoir: Record<string, unknown>[] = []
      let seen = 0
      let currentBottom = slice.bottom
      let lastProgressTime = 0
      while (currentBottom <= slice.top) {
        const currentTop = Math.min(
          currentBottom + FILTER_CHUNK_SIZE - 1,
          slice.top,
        )
        const chunk = parseRows(
          prevTableId,
          getRows(db, prevTableId, { bottom: currentBottom, top: currentTop }),
        )
        for (const item of chunk) {
          if (seen < target) {
            reservoir.push(item)
          } else {
            const j = Math.floor(Math.random() * (seen + 1))
            if (j < target) reservoir[j] = item
          }
          seen += 1
        }
        const now = Date.now()
        if (now - lastProgressTime >= PROGRESS_THROTTLE_MS) {
          postMessage({
            type: 'progress',
            current: seen,
            total,
            results: reservoir.length,
          })
          lastProgressTime = now
        }
        currentBottom = currentTop + 1
      }

      if (reservoir.length > 0) insertBatch(reservoir)
      postMessage({
        type: 'progress',
        current: seen,
        total,
        results: reservoir.length,
      })
      postMessage({ type: 'done', results: reservoir.length })
      return
    }

    // Select Range: keep a contiguous chunk of the input by position — the Nth
    // through Mth clips exactly as they appear in the tray. Single-threaded
    // (Filter.ts forces one worker) so positions are global, not per-slice.
    // 1-based and inclusive; blank "from" = start, blank "to" = end; a reversed
    // range (to < from) is swapped so 3300–3050 also works. Reads in the SAME
    // order the tray displays (COALESCE(sort_order, id), id) via SQL LIMIT/OFFSET,
    // so "clip 3050" here is the very clip the user is looking at — and a huge
    // input is paged, never loaded whole. A corrupt row still occupies its
    // position (it's dropped, not shifted), so the boundary is counted on rows
    // consumed, not rows kept.
    if (type === 'range') {
      const total = sliceTotal
      const parseBound = (v: unknown): number | null => {
        const s = v == null ? '' : String(v).trim()
        const n = parseInt(s, 10)
        return s === '' || Number.isNaN(n) ? null : n
      }
      let from = parseBound(params.from)
      let to = parseBound(params.to)
      if (from == null || from < 1) from = 1
      if (to != null && to < from) {
        const swap = from
        from = to < 1 ? 1 : to
        to = swap
      }

      // Match the tray's ordering; fall back to id if the table predates the
      // sort_order column (older projects).
      const cols = db.prepare(`PRAGMA table_info("${prevTableId}")`).all() as {
        name: string
      }[]
      const orderBy = cols.some((c) => c.name === 'sort_order')
        ? 'COALESCE(sort_order, id), id'
        : 'id'

      const insertStmt = db.prepare(
        `INSERT INTO "${nextTableId}" (JSON) VALUES (?)`,
      )
      const insertBatch = db.transaction((items: Record<string, unknown>[]) => {
        for (const it of items) insertStmt.run(JSON.stringify(it))
      })

      const want = to == null ? Infinity : to - from + 1
      if (total === 0 || want <= 0) {
        postMessage({ type: 'done', results: 0 })
        return
      }

      postMessage({ type: 'progress', current: 0, total, results: 0 })

      const pageStmt = db.prepare(
        `SELECT * FROM "${prevTableId}" ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
      )
      let inserted = 0
      let consumed = 0
      let offset = from - 1
      let lastProgressTime = 0
      while (consumed < want) {
        const batchSize = Math.min(FILTER_CHUNK_SIZE, want - consumed)
        const rows = pageStmt.all(batchSize, offset) as (
          | FilesTableRow
          | FilterTableRow
        )[]
        if (rows.length === 0) break // ran off the end of the input
        const parsed = parseRows(prevTableId, rows)
        if (parsed.length > 0) {
          insertBatch(parsed)
          inserted += parsed.length
        }
        consumed += rows.length
        offset += rows.length
        const now = Date.now()
        if (now - lastProgressTime >= PROGRESS_THROTTLE_MS) {
          postMessage({
            type: 'progress',
            current: Math.min(offset, total),
            total,
            results: inserted,
          })
          lastProgressTime = now
        }
        if (rows.length < batchSize) break // reached the end
      }

      postMessage({
        type: 'progress',
        current: total,
        total,
        results: inserted,
      })
      postMessage({ type: 'done', results: inserted })
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

    // Raw detector output per game, shared across runs and projects (Combo
    // Parser, Edgeguards Parser): detectionCache.ts.
    const detectionCache =
      traitsOf(type).detectorCache && typeof libraryFolder === 'string'
        ? new DetectionCache(libraryFolder)
        : null

    // A manually ordered input (manualOrder.ts) passes its order on: each output
    // row gets the place of the input row it came from.
    const keepOrder = hasManualOrder(db, prevTableId)
    if (keepOrder) markManualOrder(db, nextTableId)
    // Input row id -> its place in the input's order (current chunk only).
    const orderOf = new Map<number, number>()
    // Parser rows are buffered across chunks, so they carry their place here.
    const itemOrder = new WeakMap<object, number>()
    // For rows a method built without _sourceId (one-item chunks): the chunk's place.
    let chunkOrder: number | null = null
    const noteOrder = (rows: (FilesTableRow | FilterTableRow)[]) => {
      if (!keepOrder) return
      orderOf.clear()
      for (const r of rows) {
        const o = (r as FilterTableRow & { sort_order?: number | null })
          .sort_order
        orderOf.set(r.id, o ?? r.id)
      }
      chunkOrder = rows.length ? (orderOf.get(rows[0].id) ?? null) : null
    }
    const orderFor = (item: Record<string, unknown>) => {
      const kept = itemOrder.get(item)
      if (kept !== undefined) return kept
      const sid = item._sourceId
      return (
        (typeof sid === 'number' ? orderOf.get(sid) : undefined) ?? chunkOrder
      )
    }
    const stmt = db.prepare(
      keepOrder
        ? `INSERT INTO "${nextTableId}" (JSON, sort_order) VALUES (?, ?)`
        : `INSERT INTO "${nextTableId}" (JSON) VALUES (?)`,
    )
    const insertBatch = db.transaction((items: Record<string, unknown>[]) => {
      for (const item of items) {
        if (keepOrder) stmt.run(JSON.stringify(item), orderFor(item))
        else stmt.run(JSON.stringify(item))
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

    if (PARSER_METHOD_TYPES.has(type)) {
      // Parser methods read .slp files from disk (slow) — stream from DB
      // in chunks so we don't load 100K+ rows into memory before starting
      const total = sliceTotal

      // Flush size: balance between SQLite transaction overhead and result
      // freshness. Downstream filters query this table mid-run, so results
      // need to be committed frequently. A 500-row transaction takes ~5ms.
      const parserFlushSize = total < 1000 ? 100 : 500

      let totalInserted = 0
      let buffer: Record<string, unknown>[] = []
      let processed = 0
      let skippedCount = 0
      let missingCount = 0
      let corruptCount = 0
      const readErrorExamples: string[] = []
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
        noteOrder(chunkRows)

        for (const item of chunk) {
          // Every row this game produces records the game's input row, so a
          // resumed run can skip games already done (getProcessedSourceIds).
          const fromItem = (row: Record<string, unknown>) => {
            const out = { ...row, _sourceId: item._sourceId }
            const o = orderFor(item)
            if (keepOrder && o != null) itemOrder.set(out, o)
            return out
          }
          const now = Date.now()
          if (now - lastProgressTime >= PROGRESS_THROTTLE_MS) {
            postMessage({
              type: 'progress',
              current: processed,
              total,
              results: totalInserted,
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
            const res = detectionCache
              ? method(item, params, detectionCache)
              : method(item, params)
            if (res && typeof res === 'object' && 'combos' in res) {
              // slpParser returns { combos, lastFrame }
              const { combos, lastFrame, readError } = res as {
                combos: Record<string, unknown>[]
                lastFrame?: number
                readError?: 'missing' | 'corrupt'
              }
              if (readError) {
                if (readError === 'missing') missingCount++
                else corruptCount++
                if (
                  readErrorExamples.length < 3 &&
                  typeof item.path === 'string'
                ) {
                  readErrorExamples.push(item.path)
                }
              }
              if (Array.isArray(combos)) {
                for (let i = 0; i < combos.length; i += 1) {
                  if (combos[i]) buffer.push(fromItem(combos[i]))
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
                if (res[i]) buffer.push(fromItem(res[i]))
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
      detectionCache?.flush()
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
      postMessage({
        type: 'done',
        results: totalInserted,
        missing: missingCount,
        corrupt: corruptCount,
        examples: readErrorExamples,
      })
    } else {
      // Non-parser filters: process in chunks to avoid OOM
      const total = sliceTotal
      let totalInserted = 0
      let processed = 0
      let skippedCount = 0
      let currentBottom = slice.bottom
      // Slow file-reading filters (edgeguard, etc.) swallow read errors and
      // just skip the item, so a moved/deleted file — or a whole unmounted
      // drive — produces zero results with no warning. Count missing files
      // here and report them in the `done` message so Filter.ts/FilterExecutor
      // surface the same "N file(s) not found" notice as the combo parser.
      let missingCount = 0
      // Games the user's code threw on (a replay its parser can't read): skipped and
      // counted, not a failed run. Only when the batch is one game, so no other
      // game is lost with it.
      let skippedByCodeCount = 0
      let firstSkipMessage = ''
      const readErrorExamples: string[] = []

      // Slow I/O filters (open .slp files per item) use chunk size 1 so
      // results update after every file; fast filters use large chunks.
      const isSlow = REPLAY_READING_FILTERS.has(type)
      // User code on whole games almost certainly opens each replay: one game
      // per batch, so progress ticks +1 per game.
      const userCodeOnGames =
        traitsOf(type).userCode === true && prevTableId === 'files'
      const effectiveChunkSize =
        isSlow || userCodeOnGames
          ? SLOW_FILTER_CHUNK_SIZE
          : (traitsOf(type).chunkSize ?? FILTER_CHUNK_SIZE)
      let lastTickTime = 0

      // Custom filters are handed only one chunk at a time, so global operations
      // (random sampling, etc.) can't see the dataset size from `clips`. Give
      // them the FULL input row count (across all workers/chunks) via params so
      // they can sample correctly — e.g. keep each item with probability
      // count/total.
      if (type === 'custom' || type === 'aiFilter') {
        try {
          const row = db
            .prepare(`SELECT COUNT(*) AS c FROM "${prevTableId}"`)
            .get() as { c: number } | undefined
          ;(params as any).__total = row?.c ?? total
        } catch {
          ;(params as any).__total = total
        }
      }

      const prefilter = comboPrefilter(type, prevTableId, params, db)
      // Pre-checked chunks keep few rows: take bigger id ranges per query (an
      // index-backed one reads only the matches, so far bigger still).
      const rangeSize = prefilter
        ? effectiveChunkSize * (prefilter.indexed ? 2000 : 40)
        : effectiveChunkSize
      const span = Math.max(1, slice.top - slice.bottom + 1)
      while (currentBottom <= slice.top) {
        const currentTop = Math.min(currentBottom + rangeSize - 1, slice.top)
        const chunkRows = getRows(
          db,
          prevTableId,
          { bottom: currentBottom, top: currentTop },
          prefilter,
        )
        // Progress counts every row passed over, not just the ones the pre-check
        // kept: the share of the id range done so far (no extra pass over the disk).
        const scanned = prefilter
          ? Math.round(((currentTop - slice.bottom + 1) / span) * total) -
            processed
          : chunkRows.length
        const chunk = parseRows(prevTableId, chunkRows)
        noteOrder(chunkRows)

        // Pre-flight existence check for filters that open .slp files. The
        // methods themselves catch read failures and silently skip, so without
        // this an unmounted drive / moved files would yield zero results and no
        // warning. `existsSync` here is negligible next to the .slp parse it
        // gates, and only runs for slow (file-reading) filter types.
        if (isSlow) {
          for (const item of chunk) {
            if (typeof item.path === 'string' && !existsSync(item.path)) {
              missingCount++
              if (readErrorExamples.length < 3) {
                readErrorExamples.push(item.path)
              }
            }
          }
        }

        // Resume: skip exactly the items that already have results. (Skipping
        // or redoing whole batches by their first item duplicated or lost
        // results in multi-item batches.)
        let skippedHere = 0
        if (skipSet) {
          const before = chunk.length
          for (let k = chunk.length - 1; k >= 0; k -= 1) {
            const sid = chunk[k]._sourceId
            if (sid && skipSet.has(sid)) chunk.splice(k, 1)
          }
          skippedHere = before - chunk.length
          skippedCount += skippedHere
          if (chunk.length === 0) {
            processed += prefilter ? scanned : skippedHere
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
        }

        // Progress from inside a batch: methods report the item they're on;
        // pass it on (throttled) so long batches still tick up.
        const chunkStart = processed + skippedHere
        // Called synchronously within this iteration only.
        // eslint-disable-next-line no-loop-func
        const chunkEmitter = (e?: { current?: number }) => {
          const now = Date.now()
          if (now - lastTickTime < PROGRESS_THROTTLE_MS) return
          lastTickTime = now
          const within =
            typeof e?.current === 'number'
              ? Math.max(0, Math.min(e.current, chunk.length))
              : 0
          postMessage({
            type: 'progress',
            current: chunkStart + within,
            total,
            results: totalInserted,
            skipped: skippedCount,
          })
        }

        let results: Record<string, unknown>[] = []
        try {
          if (traitsOf(type).emitter) {
            const res = detectionCache
              ? method(chunk, params, chunkEmitter, detectionCache)
              : method(chunk, params, chunkEmitter)
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
          const message = errObj?.message || String(err)
          const gamePath =
            userCodeOnGames && chunk.length === 1
              ? (chunk[0] as { path?: unknown }).path
              : undefined
          if (
            typeof gamePath === 'string' &&
            message.startsWith('Runtime error in custom code')
          ) {
            // The code ran but threw on this one game (typically a replay the
            // parser can't read). Skip it, say so once with the reason, and keep
            // going: a broken script still fails, since it throws on every game.
            skippedByCodeCount++
            if (!firstSkipMessage) firstSkipMessage = message.split('\n')[0]
            if (skippedByCodeCount <= 3) {
              postMessage({
                type: 'logs',
                logs: [`Skipped ${gamePath}: ${message.split('\n')[0]}`],
              } as any)
              if (readErrorExamples.length < 3) readErrorExamples.push(gamePath)
            }
          } else {
            sendError(message, processed)
          }
          if (errObj.logs?.length) {
            postMessage({ type: 'logs', logs: errObj.logs } as any)
          }
        }

        results = results.filter(Boolean)
        // A one-item batch's results come from that item: tag them with it so
        // a resumed run knows it's done, even if the code built new objects.
        if (chunk.length === 1 && chunk[0]._sourceId) {
          for (const r of results)
            if (r._sourceId === undefined) r._sourceId = chunk[0]._sourceId
        }

        if (results.length > 0) {
          insertBatch(results)
          totalInserted += results.length
        }

        processed += prefilter ? scanned : chunk.length + skippedHere
        postMessage({
          type: 'progress',
          current: processed,
          total,
          results: totalInserted,
          skipped: skippedCount,
        })
        currentBottom = currentTop + 1
      }

      // A script that throws on EVERY game is broken, not a few bad replays: that
      // still fails the run (with the reason) instead of "completing" empty.
      if (skippedByCodeCount > 0 && skippedByCodeCount >= processed) {
        sendError(
          `The code failed on every game it ran on: ${firstSkipMessage}`,
          processed,
        )
      }

      detectionCache?.flush()
      postMessage({
        type: 'done',
        results: totalInserted,
        missing: missingCount,
        corrupt: skippedByCodeCount,
        examples: readErrorExamples,
      })
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

/** The ids at 1-based positions `bottom` and `top` of a table in id order. An
 *  empty range (e.g. the table shrank) resolves to bottom > top. */
export function resolveIdBounds(
  db: Database.Database,
  tableId: string,
  slice: { bottom: number; top: number },
): { bottom: number; top: number } {
  const idAt = db.prepare(
    `SELECT id FROM "${tableId}" ORDER BY id LIMIT 1 OFFSET ?`,
  )
  const first = idAt.get(Math.max(0, slice.bottom - 1)) as
    | { id: number }
    | undefined
  if (!first) return { bottom: 1, top: 0 }
  const last = (idAt.get(Math.max(0, slice.top - 1)) ??
    db.prepare(`SELECT MAX(id) AS id FROM "${tableId}"`).get()) as {
    id: number
  }
  return { bottom: first.id, top: last.id }
}

function getRows(
  db: Database.Database,
  tableId: string,
  slice: { bottom: number; top: number },
  prefilter: Prefilter | null = null,
): (FilesTableRow | FilterTableRow)[] {
  return db
    .prepare(
      `SELECT * FROM "${tableId}" WHERE id >= ? AND id <= ?${prefilter ? ` AND ${prefilter.sql}` : ''} ORDER BY id`,
    )
    .all(slice.bottom, slice.top, ...(prefilter?.args ?? [])) as (
    | FilesTableRow
    | FilterTableRow
  )[]
}

type Prefilter = { sql: string; args: string[]; indexed?: boolean }

/**
 * A cheap SQLite pre-check for the Combo Filter's player tags and connect codes,
 * so on a huge table only rows that could match are parsed in JavaScript (a tag
 * search over 21M clips keeps ~1 in 2,000). Each side's names must appear in the
 * row's JSON text (lowercased): a superset of matchesPlayer's exact, case-blind
 * check, so results are identical. Only for plain-ASCII values without quotes or
 * backslashes (SQLite's lower() folds A-Z only, and JSON escapes " and \);
 * anything else skips the pre-check and is filtered exactly as before.
 * LUNAR_NO_PREFILTER=1 turns it off (worker-check compares both).
 */
export function comboPrefilter(
  type: string,
  tableId: string,
  params: Record<string, any>,
  db?: Database.Database,
): Prefilter | null {
  if (type !== 'comboFilter' || tableId === 'files') return null
  if (process.env.LUNAR_NO_PREFILTER === '1') return null
  const plain = (v: string) =>
    v !== '' && /^[\x20-\x7e]+$/.test(v) && !/["\\]/.test(v)
  const hasIndex = (suffix: string) =>
    !!db &&
    !!db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='index' AND name = ? LIMIT 1",
      )
      .get(`idx_${tableId}_${suffix}`)
  const clauses: string[] = []
  const args: string[] = []
  let indexed = false
  for (const key of Object.keys(
    PLAYER_INDEXES,
  ) as (keyof typeof PLAYER_INDEXES)[]) {
    const values = parseSemicolonParam(params?.[key])
    if (values.length === 0 || !values.every(plain)) continue
    const [suffix, field] = PLAYER_INDEXES[key]
    if (hasIndex(suffix)) {
      // Exact, index-backed: only the matching rows are ever read.
      clauses.push(
        `${playerIndexExpr(field)} IN (${values.map(() => '?').join(', ')})`,
      )
      indexed = true
    } else {
      clauses.push(
        `(${values.map(() => 'instr(lower(JSON), ?) > 0').join(' OR ')})`,
      )
    }
    args.push(...values)
  }
  return clauses.length ? { sql: clauses.join(' AND '), args, indexed } : null
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
        startFrame: GAME_START_FRAME,
        // No end when the length isn't known (-123 from older imports of
        // anonymized replays): recording then runs to the end of the game.
        endFrame: row.lastFrame > 0 ? row.lastFrame : 0,
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
