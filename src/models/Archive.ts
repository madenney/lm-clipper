import {
  ArchiveInterface,
  FileInterface,
  FilterInterface,
  EventEmitterInterface,
  ShallowArchiveInterface,
  SavedCustomFilter,
  ClipInterface,
  LiteItem,
} from 'constants/types'

import { Worker } from 'worker_threads'
import fs from 'fs'
import Filter from './Filter'
import type { FileSeen, GameHeader } from '../main/replayLibrary'

import { streamSlpFilePaths } from '../lib/file'
import {
  invalidReasonFor,
  type FailCounts,
  type FailReason,
  type SkipCounts,
  type SkipReason,
} from '../lib/importSkips'
// All database work goes through DbWorker, never the main thread (db.ts
// WORKER_SYNC_FNS explains why).
import {
  getFileByPathAsync as getFileByPath,
  insertFilesAsync as insertFiles,
  getAllFromTableAsync as getAllFromTable,
  getItemsByIdsAsync as getItemsByIds,
  updateMetaDataAsync as updateMetaData,
  deleteFilterAsync as deleteFilter,
  createFilterAsync as createFilter,
  getPlayerNameCountsAsync as getPlayerNameCounts,
  getConnectCodeCountsAsync as getConnectCodeCounts,
  getAllIdsAsync,
  selectionIdsAsync,
  getTableDurationAsync,
  getWindowAsync,
  getItemsLiteAsync,
} from '../main/dbAsync'
import { headerKnowsCpu } from '../lib/cpuPlayers'
import { headerKnowsLastFrame } from '../lib/lastFrame'
import type { SelectionWire } from '../lib/selection'
import { keepsSlpz } from '../lib/slpzDecompress'
import { asyncForEach, getWorkerExecArgv } from '../lib'
import { getDescendantIds } from '../lib/filterGraph'

/** How import reaches the replay library (on the DB worker, via dbAsync). */
export type ImportLibrary = {
  /** The library folder: a .slpz in it is always read as it is. */
  folder?: string
  headers: (_files: FileSeen[]) => Promise<Record<string, GameHeader>>
  record: (_files: (FileSeen & { header: GameHeader })[]) => Promise<unknown>
}

export default class Archive {
  path: string
  name: string
  createdAt: number
  // null = count not yet known (hydrated lazily after open); preserve it so the
  // renderer can show a spinner instead of a misleading 0.
  files: number | null
  filters: FilterInterface[]
  savedCustomFilters: SavedCustomFilter[]

  activeImportPool: ImportWorkerPool | null = null

  constructor(archiveJSON: ArchiveInterface) {
    this.path = archiveJSON.path
    this.name = archiveJSON.name
    this.createdAt = archiveJSON.createdAt
    this.files = archiveJSON.files ?? null
    this.filters = archiveJSON.filters || []
    this.savedCustomFilters = archiveJSON.savedCustomFilters || []
  }

  async addFiles(
    _paths: string | string[],
    eventEmitter: EventEmitterInterface,
    options?: {
      detectDuplicates?: boolean
      abortSignal?: AbortSignal
      maxWorkers?: number
      slpzConfig?: {
        slpzBinaryPath: string
        slpzMode: 'extract' | 'replace' | 'keep'
        slpzOutputDir: string
        keepInside?: string
      }
      /** The replay library (main/replayLibrary.ts): files it already read are
       *  not parsed again, and new headers are remembered for next time. */
      library?: ImportLibrary
    },
  ) {
    const paths = Array.isArray(_paths) ? _paths : [_paths]
    const library = options?.library
    let fromLibrary = 0
    let libraryPending: (FileSeen & { header: GameHeader })[] = []
    let libraryWrites = Promise.resolve()
    const flushLibrary = () => {
      if (!library || libraryPending.length === 0) return
      const batch = libraryPending
      libraryPending = []
      libraryWrites = libraryWrites
        .then(() => library.record(batch))
        .then(
          () => undefined,
          (error) =>
            console.error('Error recording replays in the library:', error),
        )
    }
    const detectDuplicates = options?.detectDuplicates !== false
    const abortSignal = options?.abortSignal
    const maxWorkers = Math.max(1, options?.maxWorkers || 1)
    const workerPool = new ImportWorkerPool(maxWorkers, options?.slpzConfig)
    this.activeImportPool = workerPool
    const progressThrottleMs = 200
    const maxInFlight = Math.max(4, maxWorkers * 2)
    const batchThreshold = 50
    const batchTimeoutMs = 500

    let terminated = false
    let totalDiscovered = 0
    let processed = 0
    // Broken files: unreadable, damaged or cut off (lib/importSkips.ts).
    let failed = 0
    const failedReasons: FailCounts = {}
    const fail = (reason: FailReason) => {
      failed += 1
      failedReasons[reason] = (failedReasons[reason] ?? 0) + 1
    }
    let pendingNewItemCount = 0
    // Cumulative rows actually written this run. Unlike pendingNewItemCount
    // (which emitProgress drains), this survives to the return value — it's the
    // only reliable "how many files did this import add" number, since the
    // archive's own file count is lazily hydrated and reads null right after an
    // import invalidates it.
    let inserted = 0
    // Not errors: games Clipper doesn't import, and files already in the project.
    let skipped = 0
    // Why each one was left out (lib/importSkips.ts), for the result notice.
    const skippedReasons: SkipCounts = {}
    const skip = (reason: SkipReason) => {
      skipped += 1
      skippedReasons[reason] = (skippedReasons[reason] ?? 0) + 1
    }
    let duplicates = 0
    let lastProgressAt = 0
    let pendingBatch: FileInterface[] = []
    let flushQueue = Promise.resolve()
    let batchTimer: ReturnType<typeof setTimeout> | null = null

    const emitProgress = (force = false) => {
      const now = Date.now()
      if (!force && now - lastProgressAt < progressThrottleMs) {
        return
      }
      lastProgressAt = now
      eventEmitter({
        current: processed,
        total: totalDiscovered,
        ...(pendingNewItemCount > 0
          ? { newItemCount: pendingNewItemCount }
          : {}),
      })
      pendingNewItemCount = 0
    }

    // Files tasks of this run hold (being imported, or queued and not written
    // yet): a .slpz decompresses to a .slp the folder walk may also find
    // (replace mode), and rows are written in batches, so the project alone
    // can't tell. Only in-flight work is kept, so a huge import stays small.
    const takenThisRun = new Set<string>()

    const flushBatch = () => {
      if (pendingBatch.length === 0) return
      const batch = pendingBatch
      pendingBatch = []
      if (batchTimer) {
        clearTimeout(batchTimer)
        batchTimer = null
      }
      const dbPath = this.path
      flushQueue = flushQueue.then(async () => {
        if (terminated) return
        try {
          await insertFiles(dbPath, batch)
          pendingNewItemCount += batch.length
          inserted += batch.length
        } catch (error) {
          console.error('Error inserting batch:', error)
        } finally {
          // Written: the duplicate lookup finds them from here on.
          for (const f of batch) takenThisRun.delete(f.path)
        }
      })
    }

    const scheduleBatchTimer = () => {
      if (batchTimer) return
      batchTimer = setTimeout(() => {
        batchTimer = null
        flushBatch()
      }, batchTimeoutMs)
    }

    const abortHandler = () => {
      terminated = true
      if (batchTimer) {
        clearTimeout(batchTimer)
        batchTimer = null
      }
      pendingBatch = []
      workerPool.terminate()
    }

    if (abortSignal) {
      if (abortSignal.aborted) abortHandler()
      abortSignal.addEventListener('abort', abortHandler)
    }

    const inFlight = new Set<Promise<void>>()

    /** Take the file for this task; true when another task has it or it's
     *  in the project already. Taken before the lookup, so two tasks can't
     *  both pass for the same file. */
    const isDuplicate = async (file: string, claims: string[]) => {
      if (takenThisRun.has(file)) return true
      takenThisRun.add(file)
      claims.push(file)
      try {
        if (await getFileByPath(this.path, file)) return true
      } catch (error) {
        console.error('Error checking duplicate:', error)
      }
      return false
    }

    const processFile = async (path: string) => {
      // What this task took; let go when it ends, except the row it queued
      // (let go once its batch is written: the project knows it then).
      const claims: string[] = []
      let queued: string | null = null
      try {
        queued = await importOne(path, claims)
      } finally {
        for (const c of claims) if (c !== queued) takenThisRun.delete(c)
      }
    }

    /** One file: the path of the row it queued, or null. */
    const importOne = async (
      path: string,
      claims: string[],
    ): Promise<string | null> => {
      if (terminated) return null

      // "Skip .slpz files" in the SLPZ wizard: they're left out, not failed.
      if (!options?.slpzConfig && /\.slpz$/i.test(path)) {
        skip('slpz')
        processed += 1
        emitProgress()
        return null
      }

      if (detectDuplicates) {
        if (await isDuplicate(path, claims)) {
          duplicates += 1
          processed += 1
          emitProgress()
          return null
        }
      }

      let fileJSON: FileInterface | null = null
      // Known to the library and unchanged on disk: reuse its header.
      let seen: FileSeen | null = null
      // A .slpz read as it is (kept) is the same file next time too.
      const slpzConfig = options?.slpzConfig
      const kept =
        /\.slp$/i.test(path) ||
        (/\.slpz$/i.test(path) && !!slpzConfig && keepsSlpz(path, slpzConfig))
      if (library && kept) {
        try {
          const st = await fs.promises.stat(path)
          seen = { path, size: st.size, mtime: Math.floor(st.mtimeMs) }
          const header = (await library.headers([seen]))[path]
          // Headers from builds that didn't record CPU players, or that left an
          // anonymized game without its length, are parsed again.
          if (
            header &&
            headerKnowsCpu(header) &&
            headerKnowsLastFrame(header)
          ) {
            fileJSON = { ...header, path, id: '' } as FileInterface
            fromLibrary += 1
          }
        } catch (error) {
          console.error('Error reading the replay library:', error)
        }
      }
      try {
        if (!fileJSON) {
          fileJSON = await workerPool.process(path)
          if (seen && fileJSON && fileJSON.path === path) {
            const { path: _p, id: _id, ...header } = fileJSON
            libraryPending.push({ ...seen, header })
            if (libraryPending.length >= 200) flushLibrary()
          }
        }
      } catch (error) {
        if (!terminated) {
          console.error('Error processing file:', error)
          fail('unreadable')
          processed += 1
          emitProgress()
        }
        return null
      }

      if (!fileJSON || !fileJSON.isValid) {
        // A game Clipper leaves out on purpose is skipped; a broken file
        // (no settings, cut off) failed.
        const why = invalidReasonFor(fileJSON?.info)
        if (why.kind === 'skipped') skip(why.reason)
        else fail(why.reason)
        processed += 1
        emitProgress()
        return null
      }

      // A .slpz becomes its .slp: that one may be in already (or another task
      // of this run has it: the folder had both).
      if (detectDuplicates && fileJSON.path !== path) {
        if (await isDuplicate(fileJSON.path, claims)) {
          duplicates += 1
          processed += 1
          emitProgress()
          return null
        }
      }

      if (terminated) return null

      pendingBatch.push(fileJSON)
      if (pendingBatch.length >= batchThreshold) {
        flushBatch()
      } else {
        scheduleBatchTimer()
      }

      processed += 1
      emitProgress()
      return fileJSON.path
    }

    try {
      for await (const path of streamSlpFilePaths(paths, {
        signal: abortSignal,
      })) {
        if (terminated) break
        totalDiscovered += 1
        const task = processFile(path)
        inFlight.add(task)
        task.finally(() => inFlight.delete(task))
        if (inFlight.size >= maxInFlight) {
          await Promise.race(inFlight)
        }
      }

      await Promise.allSettled(inFlight)

      // Final flush of any remaining files
      flushBatch()
      await flushQueue
      flushLibrary()
      await libraryWrites
    } finally {
      if (batchTimer) {
        clearTimeout(batchTimer)
        batchTimer = null
      }

      emitProgress(true)

      if (abortSignal) {
        abortSignal.removeEventListener('abort', abortHandler)
      }

      workerPool.terminate()
      this.activeImportPool = null
    }

    return {
      terminated,
      failed,
      failedReasons,
      inserted,
      skipped,
      skippedReasons,
      duplicates,
      fromLibrary,
    }
  }

  async addFilter(newFilterJSON: FilterInterface) {
    const newFilter = new Filter(newFilterJSON)
    await newFilter.init(this.path)
    this.filters.push(newFilter)
    await this.saveMetaData()
  }

  // Replace the whole downstream chain in one shot, keeping the base Game Filter
  // (type 'files') intact. Used by the first-run starter picker: drops every
  // non-files filter's result table, then builds the supplied chain fresh.
  async replaceDownstreamFilters(downstream: FilterInterface[]) {
    const filesFilter = this.filters.find((f) => f.type === 'files')
    await asyncForEach(this.filters, async (f: FilterInterface) => {
      if (f.type === 'files') return
      await deleteFilter(this.path, f.id)
    })
    this.filters = filesFilter ? [filesFilter] : []
    await asyncForEach(downstream, async (json: FilterInterface) => {
      const newFilter = new Filter(json)
      await newFilter.init(this.path)
      this.filters.push(newFilter)
    })
    await this.saveMetaData()
  }

  async deleteFilter(filterId: string) {
    const selectedFilter = this.filters.find((f) => f.id === filterId)
    if (!selectedFilter) {
      throw new Error(
        `Archive error: removeFilter - no filter id found ${filterId}`,
      )
    }

    await deleteFilter(this.path, filterId)
    this.filters.splice(this.filters.indexOf(selectedFilter), 1)
    await this.saveMetaData()
  }

  async resetFiltersFrom(startIndex: number, branchingEnabled = true) {
    // Reset the filter at startIndex plus every filter that reads from it
    // (transitively). In a linear chain that's "everything below startIndex";
    // with branches it leaves unrelated branches' results intact.
    const root = this.filters[startIndex]
    // A locked step is never reset (its descendants are skipped by getDescendantIds).
    if (!root || root.locked) return
    const descendants = getDescendantIds(
      this.filters,
      root.id,
      branchingEnabled,
    )
    const filtersToReset = this.filters.filter(
      (f, i) => !f.locked && (i === startIndex || descendants.has(f.id)),
    )
    await asyncForEach(filtersToReset, async (filterJSON: FilterInterface) => {
      await deleteFilter(this.path, filterJSON.id)
      await createFilter(this.path, filterJSON.id)
      filterJSON.isProcessed = false
      filterJSON.results = 0
    })
    await this.saveMetaData()
  }

  async saveMetaData() {
    // Build cached counts from current filter results
    const cachedCounts: Record<string, number> = {}
    for (const filter of this.filters) {
      // Only cache real, known counts — a null means "not yet hydrated".
      if (filter.isProcessed && typeof filter.results === 'number') {
        cachedCounts[filter.id] = filter.results
      }
    }
    const objToSave: {
      name: string
      path: string
      createdAt: number
      filters: {
        id: string
        type: string
        label: string
        isProcessed: boolean
        params: Record<string, any>
        results: number | null
        inputId?: string
        lastRunMs?: number
        locked?: boolean
      }[]
      savedCustomFilters?: SavedCustomFilter[]
      cachedCounts?: Record<string, number>
    } = {
      name: this.name,
      path: this.path,
      createdAt: this.createdAt,
      filters: this.filters.map((filter) => ({
        id: filter.id,
        type: filter.type,
        label: filter.label,
        isProcessed: filter.isProcessed,
        params: filter.params,
        results: filter.results,
        ...(filter.inputId ? { inputId: filter.inputId } : {}),
        ...(typeof filter.lastRunMs === 'number'
          ? { lastRunMs: filter.lastRunMs }
          : {}),
        ...(filter.locked ? { locked: true } : {}),
      })),
      cachedCounts,
    }
    if (this.savedCustomFilters && this.savedCustomFilters.length > 0) {
      objToSave.savedCustomFilters = this.savedCustomFilters
    }
    await updateMetaData(this.path, objToSave)
  }

  async shallowCopy() {
    const shallowArchive: ShallowArchiveInterface = {
      path: this.path,
      name: this.name,
      createdAt: this.createdAt,
      files: this.files,
      filters: this.filters.map((filter) => ({
        id: filter.id,
        type: filter.type,
        label: filter.label,
        isProcessed: filter.isProcessed,
        params: filter.params,
        results: filter.results,
        resumable: filter.resumable,
        ...(filter.resumeProgress
          ? { resumeProgress: filter.resumeProgress }
          : {}),
        ...(filter.inputId ? { inputId: filter.inputId } : {}),
        ...(typeof filter.lastRunMs === 'number'
          ? { lastRunMs: filter.lastRunMs }
          : {}),
        ...(filter.locked ? { locked: true } : {}),
      })),
      savedCustomFilters: this.savedCustomFilters || [],
    }

    return shallowArchive
  }

  async getItems(params: {
    filterId: string
    numPerPage?: number
    currentPage?: number
    offset?: number
    limit?: number
    lite?: boolean
    /** A newer read on this lane supersedes this one (it throws StaleReadError). */
    lane?: string
  }) {
    const { filterId, numPerPage, currentPage, offset, limit, lite, lane } =
      params
    const resolvedLimit = limit ?? numPerPage ?? 0
    const resolvedOffset = offset ?? (currentPage || 0) * (numPerPage || 0)

    if (resolvedLimit <= 0) return []

    const safeOffset = Math.max(0, resolvedOffset)
    const response =
      lite && filterId === 'files'
        ? await getItemsLiteAsync(this.path, resolvedLimit, safeOffset)
        : await getWindowAsync(
            this.path,
            filterId,
            resolvedLimit,
            safeOffset,
            lane,
          )

    return this.parseRows(filterId, response, lite)
  }

  async getAllItems(filterId: string) {
    const response = await getAllFromTable(this.path, filterId)
    return this.parseRows(filterId, response as Record<string, any>[])
  }

  async getItemsByIds(filterId: string, ids: number[]) {
    const response = await getItemsByIds(this.path, filterId, ids)
    return this.parseRows(filterId, response as Record<string, any>[])
  }

  /** A tray selection's row ids in display order, at most `limit`. */
  async getSelectionIds(
    filterId: string,
    selection: SelectionWire,
    limit?: number,
  ): Promise<number[]> {
    return Array.from(
      await selectionIdsAsync(this.path, filterId, selection, limit),
    )
  }

  getAllIds(filterId: string): Promise<string[]> {
    return getAllIdsAsync(this.path, filterId)
  }

  getTableDuration(filterId: string): Promise<number> {
    return getTableDurationAsync(this.path, filterId)
  }

  async getNames() {
    return getPlayerNameCounts(this.path)
  }

  async getConnectCodes() {
    return getConnectCodeCounts(this.path)
  }

  private parseRows(
    filterId: string,
    response: Record<string, any>[],
    lite?: boolean,
  ) {
    const items: Array<FileInterface | ClipInterface | LiteItem> = []

    if (!response || response.length === 0) {
      return items
    }

    if (filterId === 'files') {
      response.forEach((row: any) => {
        if (!row.id) return
        if (lite) {
          const rawStage =
            typeof row.stage === 'number' ? row.stage : parseInt(row.stage, 10)
          items.push({
            id: String(row.id),
            stage: Number.isNaN(rawStage) ? 0 : rawStage,
          })
          return
        }
        const players =
          typeof row.players === 'string'
            ? JSON.parse(row.players)
            : row.players
        const file = {
          id: row.id,
          path: row.path,
          players,
          winner: row.winner,
          stage: row.stage,
          startedAt: row.startedAt,
          lastFrame: row.lastFrame,
          isProcessed: row.isProcessed === 1,
          startFrame: 0,
          endFrame: 0,
          info: row.info,
          isValid: true,
        }
        items.push(file)
      })
    } else {
      response.forEach((row: any) => {
        if (!row.JSON) return
        if (lite) {
          try {
            const obj = JSON.parse(row.JSON)
            const rawStage = parseInt(obj?.stage, 10)
            items.push({
              id: String(row.id),
              stage: Number.isNaN(rawStage) ? 0 : rawStage,
            })
          } catch (error) {
            console.error('Error parsing filter row:', error)
          }
        } else {
          try {
            const obj = JSON.parse(row.JSON)
            obj.id = row.id
            items.push(obj)
          } catch (error) {
            console.error('Error parsing filter row:', error)
          }
        }
      })
    }

    return items
  }
}

type ImportWorkerResponse =
  | { type: 'result'; id: number; fileJSON: FileInterface }
  | { type: 'error'; id: number; error: string }

type ImportWorkerTask = {
  id: number
  filePath: string
  resolve: (_fileJSON: FileInterface) => void
  reject: (_error: Error) => void
}

class ImportWorkerPool {
  private workers: Worker[] = []
  private idle: Worker[] = []
  private queue: ImportWorkerTask[] = []
  private pending = new Map<number, ImportWorkerTask>()
  private activeByWorker = new Map<Worker, number>()
  private nextId = 1
  private terminated = false
  private workerExecArgv?: string[]
  private slpzConfig?: {
    slpzBinaryPath: string
    slpzMode: 'extract' | 'replace' | 'keep'
    slpzOutputDir: string
    keepInside?: string
  }

  constructor(
    size: number,
    slpzConfig?: {
      slpzBinaryPath: string
      slpzMode: 'extract' | 'replace' | 'keep'
      slpzOutputDir: string
      keepInside?: string
    },
  ) {
    this.workerExecArgv = getWorkerExecArgv()
    this.slpzConfig = slpzConfig
    for (let i = 0; i < size; i += 1) {
      this.addWorker()
    }
  }

  process(filePath: string) {
    if (this.terminated) {
      return Promise.reject(new Error('Import cancelled'))
    }
    return new Promise<FileInterface>((resolve, reject) => {
      const task: ImportWorkerTask = {
        id: this.nextId,
        filePath,
        resolve,
        reject,
      }
      this.nextId += 1
      this.queue.push(task)
      this.schedule()
    })
  }

  getWorkerStatus(): Array<{ workerId: number; filePath: string | null }> {
    return this.workers.map((worker, i) => {
      const taskId = this.activeByWorker.get(worker)
      const task = taskId !== undefined ? this.pending.get(taskId) : undefined
      return { workerId: i, filePath: task?.filePath ?? null }
    })
  }

  terminate() {
    if (this.terminated) return
    this.terminated = true
    const cancelError = new Error('Import cancelled')

    this.queue.forEach((task) => task.reject(cancelError))
    this.queue = []

    this.pending.forEach((task) => task.reject(cancelError))
    this.pending.clear()
    this.activeByWorker.clear()
    this.idle = []

    this.workers.forEach((worker) => worker.terminate())
    this.workers = []
  }

  private addWorker() {
    const worker = new Worker(new URL('./ImportWorker.ts', import.meta.url), {
      ...(this.workerExecArgv ? { execArgv: this.workerExecArgv } : {}),
      ...(this.slpzConfig
        ? { workerData: { slpzConfig: this.slpzConfig } }
        : {}),
    })
    worker.on('message', (message: ImportWorkerResponse) => {
      this.handleMessage(worker, message)
    })
    worker.on('error', (error) => {
      this.handleWorkerError(worker, error)
    })
    worker.on('exit', (code) => {
      if (code !== 0) {
        this.handleWorkerError(
          worker,
          new Error(`Import worker exited with code ${code}`),
        )
      }
    })
    this.workers.push(worker)
    this.idle.push(worker)
  }

  private handleMessage(worker: Worker, message: ImportWorkerResponse) {
    const task = this.pending.get(message.id)
    if (!task) return
    this.pending.delete(message.id)
    this.activeByWorker.delete(worker)
    this.idle.push(worker)

    if (message.type === 'result') {
      task.resolve(message.fileJSON)
    } else {
      task.reject(new Error(message.error))
    }

    this.schedule()
  }

  private workerErrorCount = 0
  private readonly MAX_WORKER_RETRIES = 10
  // A crash fires 'error' and then 'exit' (code 1) for the same worker: count
  // and replace it once (launch review FLT-9).
  private readonly gone = new WeakSet<Worker>()

  private handleWorkerError(worker: Worker, error: Error) {
    if (this.terminated || this.gone.has(worker)) return
    this.gone.add(worker)
    const activeId = this.activeByWorker.get(worker)
    if (activeId !== undefined) {
      const task = this.pending.get(activeId)
      task?.reject(error)
      this.pending.delete(activeId)
    }
    this.activeByWorker.delete(worker)
    this.idle = this.idle.filter((item) => item !== worker)
    this.workers = this.workers.filter((item) => item !== worker)
    this.workerErrorCount++
    if (this.workerErrorCount < this.MAX_WORKER_RETRIES) {
      this.addWorker()
    } else if (this.workers.length === 0) {
      // No worker left and none will be made: whatever is still queued can never
      // run. Fail it (the import reports those files) instead of waiting forever.
      const stopped = new Error(
        'The import workers stopped (a replay may be crashing the reader).',
      )
      this.queue.forEach((task) => task.reject(stopped))
      this.queue = []
    }
    this.schedule()
  }

  private schedule() {
    if (this.terminated) return
    while (this.idle.length > 0 && this.queue.length > 0) {
      const worker = this.idle.pop()
      const task = this.queue.shift()
      if (!worker || !task) return
      this.pending.set(task.id, task)
      this.activeByWorker.set(worker, task.id)
      worker.postMessage({
        type: 'process',
        id: task.id,
        filePath: task.filePath,
      })
    }
  }
}
