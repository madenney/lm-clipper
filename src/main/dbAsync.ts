/**
 * Async wrappers around expensive DB operations.
 * Routes queries through DbWorker.ts so they never block the main thread.
 */
import { Worker } from 'worker_threads'
import type { OverviewChunk, OverviewCursor } from './overview'

import type { WorkerSyncFns } from './db'
import type { LibraryFns } from './replayLibrary'
import type { SelectionWire } from '../lib/selection'
import { ReadLane, StaleReadError } from './readLane'

// The tray's quick window reads, on their own read-only connection (readLane.ts).
const readLane = new ReadLane(
  (gens) =>
    new Worker(new URL('./DbReadWorker.ts', import.meta.url), {
      workerData: { gens },
    }),
)
// Slow background reads (a table's or selection's length, warming the overview
// cache) on a third connection: a 30 s sum over 21M rows never holds up the
// tray's windows, overview chunks or DbWorker's writes and counts.
const slowLane = new ReadLane(
  (gens) =>
    new Worker(new URL('./DbReadWorker.ts', import.meta.url), {
      workerData: { gens },
    }),
)
/** Selection lengths: a newer one skips older ones that haven't started. */
const DURATION_LANE = 'duration'

let worker: Worker | null = null
let requestId = 0
const pending = new Map<
  number,
  { resolve: (_data: any) => void; reject: (_err: Error) => void }
>()

function getWorker(): Worker {
  if (worker) return worker
  worker = new Worker(new URL('./DbWorker.ts', import.meta.url))
  worker.on(
    'message',
    (msg: { id: number; type: string; data?: any; error?: string }) => {
      const p = pending.get(msg.id)
      if (!p) return
      pending.delete(msg.id)
      if (msg.type === 'result') {
        p.resolve(msg.data)
      } else {
        p.reject(new Error(msg.error || 'DbWorker error'))
      }
    },
  )
  worker.on('error', (err) => {
    // Reject all pending requests
    for (const [id, p] of pending) {
      p.reject(err)
      pending.delete(id)
    }
    worker = null
  })
  const self = worker
  worker.on('exit', (code) => {
    // An exit without an 'error' (the worker ended itself, or was stopped from
    // elsewhere) must not leave calls waiting for an answer that never comes:
    // spinners that never stop, a project that never finishes opening
    // (launch review REL-4).
    // Only for the live worker: a worker that terminateDbWorker() already
    // replaced must not fail the new one's calls.
    if (worker !== self) return
    worker = null
    for (const [id, p] of pending) {
      p.reject(new Error(`The database worker stopped (exit code ${code}).`))
      pending.delete(id)
    }
  })
  return worker
}

function call(
  dbPath: string,
  method: string,
  extra: Record<string, any> = {},
): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = ++requestId
    pending.set(id, { resolve, reject })
    getWorker().postMessage({ id, dbPath, method, ...extra })
  })
}

/** Terminates the worker (e.g. on app quit or DB close). */
export function terminateDbWorker(): void {
  readLane.terminate()
  slowLane.terminate()
  if (worker) {
    worker.terminate().catch(() => {})
    worker = null
    for (const [, p] of pending) {
      p.reject(new Error('DbWorker terminated'))
    }
    pending.clear()
  }
}

/**
 * Graceful shutdown for app quit: asks the worker to cleanly close its DB
 * connection (releasing the file handle so sidecars can be deleted), waits for
 * the ack, then terminates. Bounded by `timeoutMs` so quit can never hang.
 */
export async function shutdownDbWorker(timeoutMs = 1500): Promise<void> {
  // The read connection first: the last connection to close removes the WAL.
  await Promise.all([readLane.close(timeoutMs), slowLane.close(timeoutMs)])
  readLane.terminate()
  slowLane.terminate()
  return new Promise((resolve) => {
    const w = worker
    if (!w) {
      resolve()
      return
    }
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      w.off('message', onMessage)
      worker = null
      for (const [, p] of pending) {
        p.reject(new Error('DbWorker shutting down'))
      }
      pending.clear()
      w.terminate().catch(() => {})
      resolve()
    }
    const onMessage = (msg: { type?: string }) => {
      if (msg && msg.type === 'closed') finish()
    }
    w.on('message', onMessage)
    try {
      w.postMessage({ id: -1, __control: 'close' })
    } catch (_) {
      finish()
      return
    }
    setTimeout(finish, timeoutMs)
  })
}

// ── Async query functions ────────────────────────────────────────────

/**
 * Run one of db.ts's synchronous functions in DbWorker (never on the main
 * thread). The first argument is always the project path. Calls run one at a
 * time in order, on the worker's single connection.
 */
export function dbSync<K extends keyof WorkerSyncFns>(
  fn: K,
  ...args: Parameters<WorkerSyncFns[K]>
): Promise<ReturnType<WorkerSyncFns[K]>> {
  return call(args[0] as string, 'callSync', { fn, args })
}

/**
 * Close the worker's connection (checkpointing the WAL into the project file)
 * without stopping the worker. Await it before copying, moving or switching a
 * project so the file on disk is complete.
 */
/** Run a replay-library function (replayLibrary.ts) on the DB worker. */
export function libraryCall<K extends keyof LibraryFns>(
  fn: K,
  ...args: Parameters<LibraryFns[K]>
): Promise<ReturnType<LibraryFns[K]>> {
  return call('', 'library', { fn, args })
}

export async function closeDbAsync(): Promise<void> {
  // The read connection first, so the main one's close checkpoints and lets go
  // of the file completely.
  await Promise.all([readLane.close(), slowLane.close()])
  return call('', 'closeDb')
}

export const getMetaData = (dbPath: string) => getMetaDataAsync(dbPath)

function viaWorker<K extends keyof WorkerSyncFns>(fn: K) {
  return (...args: Parameters<WorkerSyncFns[K]>) => dbSync(fn, ...args)
}

// Worker-backed versions of db.ts's functions for main-process callers.
export const createDBAsync = viaWorker('createDB')
export const getLunarClipIdsAsync = viaWorker('getLunarClipIds')
export const insertFilterRowsAsync = viaWorker('insertFilterRows')
export const updateMetaDataAsync = viaWorker('updateMetaData')
export const getFileByPathAsync = viaWorker('getFileByPath')
export const insertFilesAsync = viaWorker('insertFiles')
export const getPlayerNameCountsAsync = viaWorker('getPlayerNameCounts')
export const getConnectCodeCountsAsync = viaWorker('getConnectCodeCounts')
export const getAllFromTableAsync = viaWorker('getAllFromTable')
export const getItemsByIdsAsync = viaWorker('getItemsByIds')
export const createFilterAsync = viaWorker('createFilter')
export const deleteFilterAsync = viaWorker('deleteFilter')
export const upsertFilterRunAsync = viaWorker('upsertFilterRun')
export const getFilterRunAsync = viaWorker('getFilterRun')

export function getMetaDataAsync(dbPath: string): Promise<any> {
  return call(dbPath, 'getMetadata')
}

export function getTableCountAsync(
  dbPath: string,
  tableId: string,
): Promise<number> {
  return call(dbPath, 'getTableCount', { tableId })
}

export function getFilterCountAsync(
  dbPath: string,
  tableId: string,
): Promise<number> {
  return call(dbPath, 'getFilterCount', { tableId })
}

/**
 * A slow read on the background lane; DbWorker answers if that lane can't (the
 * project isn't readable read-only). A superseded one rejects with
 * StaleReadError (isStaleRead).
 */
async function slowRead<T>(
  method: string,
  args: Record<string, unknown> & { dbPath: string },
  fallback: () => Promise<T>,
  lane?: string,
): Promise<T> {
  let reply
  try {
    reply = await slowLane.query(method, args, lane)
  } catch (err) {
    console.warn(
      `[dbAsync] background lane failed (${method}), using the DB worker:`,
      err instanceof Error ? err.message : err,
    )
    return fallback()
  }
  if (reply && typeof reply === 'object' && 'stale' in reply)
    throw new StaleReadError()
  return reply as T
}

/** A table's length in frames, on the background lane (a newer length request
 *  skips this one if it hasn't started). */
export function getTableDurationAsync(
  dbPath: string,
  tableId: string,
): Promise<number> {
  return slowRead(
    'tableDuration',
    { dbPath, tableId },
    () => call(dbPath, 'getTableDuration', { tableId }),
    DURATION_LANE,
  )
}

export function getAllIdsAsync(
  dbPath: string,
  tableId: string,
): Promise<string[]> {
  return call(dbPath, 'getAllIds', { tableId })
}

/** A tray selection's ids in display order (selectionSql.ts), at most `limit`. */
export function selectionIdsAsync(
  dbPath: string,
  tableId: string,
  selection: SelectionWire,
  limit?: number,
): Promise<Uint32Array> {
  return call(dbPath, 'selectionIds', { tableId, selection, limit })
}

/** A tray selection's length in frames and its row count (selectionSql.ts). */
export function selectionFramesAsync(
  dbPath: string,
  tableId: string,
  selection: SelectionWire,
): Promise<{ frames: number; count: number }> {
  return slowRead(
    'selectionFrames',
    { dbPath, tableId, selection },
    () => call(dbPath, 'selectionFrames', { tableId, selection }),
    DURATION_LANE,
  )
}

export function getProcessedSourceIdsAsync(
  dbPath: string,
  tableId: string,
): Promise<number[]> {
  return call(dbPath, 'getProcessedSourceIds', { tableId })
}

export function deleteRowsBySourceIdAsync(
  dbPath: string,
  tableId: string,
  sourceIds: number[],
): Promise<number> {
  return call(dbPath, 'deleteRowsBySourceId', { tableId, sourceIds })
}

export function deleteRowsByFilePathsAsync(
  dbPath: string,
  tableId: string,
  filePaths: string[],
): Promise<number> {
  return call(dbPath, 'deleteRowsByFilePaths', { tableId, filePaths })
}

export function getItemsAsync(
  dbPath: string,
  tableId: string,
  limit: number,
  offset: number,
): Promise<any[]> {
  return call(dbPath, 'getItems', { tableId, limit, offset })
}

/**
 * The same rows as getItemsAsync (LIMIT/OFFSET in tray order), read on the read
 * lane through a position index instead of OFFSET (rowSeek.ts). With `lane`, a
 * newer read on that lane supersedes this one: it then rejects with
 * StaleReadError (isStaleRead). If the read lane can't serve it (e.g. the project
 * file isn't readable read-only), the main DB worker's OFFSET query does.
 */
export async function getWindowAsync(
  dbPath: string,
  tableId: string,
  limit: number,
  offset: number,
  lane?: string,
): Promise<any[]> {
  let reply
  try {
    reply = await readLane.readWindow(dbPath, tableId, offset, limit, lane)
  } catch (err) {
    console.warn(
      '[dbAsync] read lane failed, reading on the DB worker:',
      err instanceof Error ? err.message : err,
    )
    return getItemsAsync(dbPath, tableId, limit, offset)
  }
  if ('stale' in reply) throw new StaleReadError()
  return reply.rows
}

/** The overview cache's fingerprint of a table (main/overview.ts). */
export function getOverviewSignatureAsync(
  dbPath: string,
  tableId: string,
): Promise<string> {
  return call(dbPath, 'getOverviewSignature', { tableId })
}

/** The tray overview's next chunk (main/overview.ts). */
export function getOverviewChunkAsync(
  dbPath: string,
  tableId: string,
  cursor: OverviewCursor,
  limit: number,
): Promise<OverviewChunk> {
  return call(dbPath, 'getOverviewChunk', { tableId, cursor, limit })
}

/** The overview's fingerprint and chunks on the background lane, for warming
 *  the disk cache without holding up DbWorker (controller.ts warmOverview). */
export function getOverviewSignatureBackground(
  dbPath: string,
  tableId: string,
): Promise<string> {
  return slowRead('overviewSignature', { dbPath, tableId }, () =>
    getOverviewSignatureAsync(dbPath, tableId),
  )
}

export function getOverviewChunkBackground(
  dbPath: string,
  tableId: string,
  cursor: OverviewCursor,
  limit: number,
): Promise<OverviewChunk> {
  return slowRead('overviewChunk', { dbPath, tableId, cursor, limit }, () =>
    getOverviewChunkAsync(dbPath, tableId, cursor, limit),
  )
}

export function getItemsLiteAsync(
  dbPath: string,
  limit: number,
  offset: number,
): Promise<any[]> {
  return call(dbPath, 'getItemsLite', { limit, offset })
}

export function deleteFilterRunAsync(
  dbPath: string,
  filterId: string,
): Promise<void> {
  return call(dbPath, 'deleteFilterRun', { filterId })
}

export function updateFilterRunProgressAsync(
  dbPath: string,
  filterId: string,
  processed: number,
): Promise<void> {
  return call(dbPath, 'updateFilterRunProgress', { filterId, processed })
}

export function deleteFilesAsync(
  dbPath: string,
  fileIds: number[],
): Promise<void> {
  return call(dbPath, 'deleteFiles', { fileIds })
}

/** Remove games (a few thousand ids) and every filter row made from them;
 *  resolves with their paths (removeRows.ts). */
export function removeGamesAsync(
  dbPath: string,
  fileIds: number[],
  filterIds: string[],
): Promise<string[]> {
  return call(dbPath, 'removeGames', { fileIds, filterIds })
}

/** Remove a step's result rows and what the later steps made from them. */
export function removeResultsCascadeAsync(
  dbPath: string,
  tableId: string,
  rowIds: number[],
  downstream: { id: string; type: string }[],
): Promise<Record<string, number>> {
  return call(dbPath, 'removeResultsCascade', { tableId, rowIds, downstream })
}

/** Remove games by path from a project other than the open one (My Replays). */
export function removeGamesFromProjectFileAsync(
  projectPath: string,
  paths: string[],
): Promise<number> {
  return call('', 'removeGamesFromProjectFile', { projectPath, paths })
}

export function getFilePathsByIdsAsync(
  dbPath: string,
  fileIds: number[],
): Promise<string[]> {
  return call(dbPath, 'getFilePathsByIds', { fileIds })
}

export function deleteRowsAsync(
  dbPath: string,
  tableId: string,
  rowIds: number[],
): Promise<void> {
  return call(dbPath, 'deleteRows', { tableId, rowIds })
}

export function updateSortOrderAsync(
  dbPath: string,
  tableId: string,
  updates: { id: number; sort_order: number }[],
): Promise<void> {
  return call(dbPath, 'updateSortOrder', { tableId, updates })
}

export function updateMetadataNameAsync(
  dbPath: string,
  name: string,
): Promise<void> {
  return call(dbPath, 'updateMetadataName', { name })
}

export function updateMetadataPathAndNameAsync(
  dbPath: string,
  newPath: string,
  name: string,
): Promise<void> {
  return call(dbPath, 'updateMetadataPathAndName', { path: newPath, name })
}

export function getGameFilterRowInfo(
  dbPath: string,
  tableId: string,
  rowIds: number[],
): Promise<{ fileId: number; filePath: string }[]> {
  return call(dbPath, 'getGameFilterRowInfo', { tableId, rowIds })
}
