/**
 * Async wrappers around expensive DB operations.
 * Routes queries through DbWorker.ts so they never block the main thread.
 */
import { Worker } from 'worker_threads'

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
  worker.on('exit', () => {
    worker = null
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
  if (worker) {
    worker.terminate().catch(() => {})
    worker = null
    for (const [, p] of pending) {
      p.reject(new Error('DbWorker terminated'))
    }
    pending.clear()
  }
}

// ── Async query functions ────────────────────────────────────────────

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

export function getTableDurationAsync(
  dbPath: string,
  tableId: string,
): Promise<number> {
  return call(dbPath, 'getTableDuration', { tableId })
}

export function getAllIdsAsync(
  dbPath: string,
  tableId: string,
): Promise<string[]> {
  return call(dbPath, 'getAllIds', { tableId })
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
