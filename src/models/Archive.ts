import {
  ArchiveInterface,
  FileInterface,
  FilterInterface,
  EventEmitterInterface,
  ShallowArchiveInterface,
  PlayerInterface,
  ClipInterface,
  LiteItem,
} from 'constants/types'

import Filter from './Filter'

import { Worker } from 'worker_threads'
import { streamSlpFilePaths } from '../lib/file'
import {
  getMetaData,
  getFileByPath,
  insertFiles,
  getFiles,
  getItems,
  getItemsLite,
  getAllFromTable,
  getItemsByIds,
  updateMetaData,
  deleteFilter,
  createFilter,
} from '../main/db'
import { asyncForEach } from '../lib'

export default class Archive {
  path: string
  name: string
  createdAt: number
  files: number
  filters: FilterInterface[]

  constructor(archiveJSON: ArchiveInterface) {
    this.path = archiveJSON.path
    this.name = archiveJSON.name
    this.createdAt = archiveJSON.createdAt
    this.files = archiveJSON.files || 0
    this.filters = archiveJSON.filters || []
  }

  async addFiles(
    _paths: string | string[],
    eventEmitter: EventEmitterInterface,
    options?: {
      detectDuplicates?: boolean
      abortSignal?: AbortSignal
      maxWorkers?: number
    }
  ) {
    const paths = Array.isArray(_paths) ? _paths : [_paths]
    const detectDuplicates = options?.detectDuplicates !== false
    const abortSignal = options?.abortSignal
    const maxWorkers = Math.max(1, options?.maxWorkers || 1)
    const workerPool = new ImportWorkerPool(maxWorkers)
    const progressThrottleMs = 200
    const maxInFlight = Math.max(4, maxWorkers * 2)
    const batchThreshold = 50
    const batchTimeoutMs = 500

    let terminated = false
    let totalDiscovered = 0
    let processed = 0
    let failed = 0
    let pendingNewItemCount = 0
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
        ...(pendingNewItemCount > 0 ? { newItemCount: pendingNewItemCount } : {}),
      })
      pendingNewItemCount = 0
    }

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
        } catch (error) {
          console.log('Error inserting batch:', error)
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

    const processFile = async (path: string) => {
      if (terminated) return

      if (detectDuplicates) {
        try {
          const existingFile = await getFileByPath(this.path, path)
          if (existingFile) {
            processed += 1
            emitProgress()
            return
          }
        } catch (error) {
          console.log('Error checking duplicate:', error)
        }
      }

      let fileJSON: FileInterface | null = null
      try {
        fileJSON = await workerPool.process(path)
      } catch (error) {
        if (!terminated) {
          console.log('Error processing file:', error)
          failed += 1
          processed += 1
          emitProgress()
        }
        return
      }

      if (!fileJSON || !fileJSON.isValid) {
        processed += 1
        emitProgress()
        return
      }

      if (terminated) return

      pendingBatch.push(fileJSON)
      if (pendingBatch.length >= batchThreshold) {
        flushBatch()
      } else {
        scheduleBatchTimer()
      }

      processed += 1
      emitProgress()
    }

    try {
      for await (const path of streamSlpFilePaths(paths, { signal: abortSignal })) {
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
    }

    return { terminated, failed }
  }

  async addFilter(newFilterJSON: FilterInterface) {
    const newFilter = new Filter(newFilterJSON)
    await newFilter.init(this.path)
    this.filters.push(newFilter)
    await this.saveMetaData()
  }

  async deleteFilter(filterId: string) {
    const selectedFilter = this.filters.find((f) => f.id === filterId)
    if (!selectedFilter) {
      throw new Error(`Archive error: removeFilter - no filter id found ${filterId}`)
    }

    await deleteFilter(this.path, filterId)
    this.filters.splice(this.filters.indexOf(selectedFilter), 1)
    await this.saveMetaData()
  }

  async resetFiltersFrom(startIndex: number) {
    const filtersToReset = this.filters.slice(startIndex)
    await asyncForEach(filtersToReset, async (filterJSON) => {
      await deleteFilter(this.path, filterJSON.id)
      await createFilter(this.path, filterJSON.id)
      filterJSON.isProcessed = false
      filterJSON.results = 0
    })
    await this.saveMetaData()
  }

  async saveMetaData() {
    const objToSave = {
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
      })),
    }
    await updateMetaData(this.path, objToSave)
  }

  async shallowCopy() {
    const metadata = await getMetaData(this.path)

    const shallowArchive: ShallowArchiveInterface = {
      path: this.path,
      name: metadata.name,
      createdAt: metadata.createdAt,
      files: metadata.files,
      filters: metadata.filters,
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
  }) {
    const { filterId, numPerPage, currentPage, offset, limit, lite } = params
    const resolvedLimit = limit ?? numPerPage ?? 0
    const resolvedOffset =
      offset ?? ((currentPage || 0) * (numPerPage || 0))

    if (resolvedLimit <= 0) return []

    const safeOffset = Math.max(0, resolvedOffset)
    const response =
      lite && filterId === 'files'
        ? await getItemsLite(this.path, resolvedLimit, safeOffset)
        : await getItems(this.path, filterId, resolvedLimit, safeOffset)

    return this.parseRows(filterId, response, lite)
  }

  async getAllItems(filterId: string) {
    const response = await getAllFromTable(this.path, filterId)
    return this.parseRows(filterId, response)
  }

  async getItemsByIds(filterId: string, ids: number[]) {
    const response = await getItemsByIds(this.path, filterId, ids)
    return this.parseRows(filterId, response)
  }

  async getNames() {
    const files = await getFiles(this.path)

    const namesObj: { [key: string]: number } = {}
    files.forEach((file: any) => {
      if (!file.players) return
      const players = typeof file.players === 'string'
        ? JSON.parse(file.players)
        : file.players
      players.forEach((player: PlayerInterface) => {
        const name = player.displayName
        if (namesObj[name]) {
          namesObj[name] += 1
        } else {
          namesObj[name] = 1
        }
      })
    })
    const names: { name: string; total: number }[] = []
    Object.keys(namesObj).forEach((key) => {
      names.push({ name: key, total: namesObj[key] })
    })
    const sortedNames = names.sort((a, b) => b.total - a.total)
    return sortedNames
  }

  private parseRows(filterId: string, response: any[], lite?: boolean) {
    const items: Array<FileInterface | ClipInterface | LiteItem> = []

    if (!response || response.length === 0) {
      return items
    }

    if (filterId === 'files') {
      response.forEach((row: any) => {
        if (!row.id) return
        if (lite) {
          const rawStage = typeof row.stage === 'number' ? row.stage : parseInt(row.stage, 10)
          items.push({
            id: String(row.id),
            stage: Number.isNaN(rawStage) ? 0 : rawStage,
          })
          return
        }
        const players = typeof row.players === 'string'
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
            console.log('Error parsing filter row:', error)
          }
        } else {
          try {
            const obj = JSON.parse(row.JSON)
            obj.id = row.id
            items.push(obj)
          } catch (error) {
            console.log('Error parsing filter row:', error)
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
  resolve: (fileJSON: FileInterface) => void
  reject: (error: Error) => void
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

  constructor(size: number) {
    this.workerExecArgv = getWorkerExecArgv()
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
          new Error(`Import worker exited with code ${code}`)
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

  private handleWorkerError(worker: Worker, error: Error) {
    if (this.terminated) return
    const activeId = this.activeByWorker.get(worker)
    if (activeId !== undefined) {
      const task = this.pending.get(activeId)
      task?.reject(error)
      this.pending.delete(activeId)
    }
    this.activeByWorker.delete(worker)
    this.idle = this.idle.filter((item) => item !== worker)
    this.workers = this.workers.filter((item) => item !== worker)
    this.addWorker()
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

function getWorkerExecArgv() {
  const mode = process.env.LM_CLIPPER_WORKER_TS_NODE
  if (!mode) return undefined
  if (mode === 'esm') return ['--loader', 'ts-node/esm']
  return ['-r', 'ts-node/register/transpile-only']
}
