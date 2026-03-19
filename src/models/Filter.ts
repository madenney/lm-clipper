import { Worker } from 'worker_threads'
import {
  FilterInterface,
  EventEmitterInterface,
  WorkerMessage,
} from '../constants/types'
import {
  getTableLength,
  createFilter,
  deleteFilter,
  upsertFilterRun,
  deleteFilterRun,
  getProcessedSourceIds,
} from '../main/db'
import { getWorkerExecArgv } from '../lib'

type Slice = {
  bottom: number
  top: number
  completed: number
  id: number
}

export default class Filter {
  id: string
  label: string
  type: string
  isProcessed: boolean
  params: Record<string, any>
  results: number
  private _activeSlices: Slice[] | null = null

  constructor(filterJSON: FilterInterface) {
    this.id = filterJSON.id
    this.label = filterJSON.label
    this.type = filterJSON.type
    this.isProcessed = filterJSON.isProcessed
    this.params = filterJSON.params
    this.results = filterJSON.results
  }

  async init(dbPath: string) {
    await createFilter(dbPath, this.id)
  }

  async delete(dbPath: string) {
    await deleteFilter(dbPath, this.id)
  }

  getWorkerStatus(): Array<{
    workerId: number
    completed: number
    total: number
  }> | null {
    if (!this._activeSlices) return null
    return this._activeSlices.map((s, i) => ({
      workerId: i,
      completed: s.completed,
      total: s.top - s.bottom + 1,
    }))
  }

  async run3(
    dbPath: string,
    prevTableId: string,
    numFilterThreads: number,
    eventEmitter: EventEmitterInterface,
    abortSignal?: AbortSignal,
    options?: { resume?: boolean },
  ): Promise<{ terminated: boolean; errors: string[]; logs?: string[] }> {
    const resume = options?.resume === true
    const prevResultsLength = await getTableLength(dbPath, prevTableId)
    let maxFiles = prevResultsLength

    if (this.params.maxFiles !== undefined && this.params.maxFiles !== '') {
      const parsed = parseInt(this.params.maxFiles, 10)
      if (!Number.isNaN(parsed) && parsed >= 0) {
        maxFiles = Math.min(prevResultsLength, parsed)
      }
    }

    // Build skip set for resume mode
    let skipSourceIds: number[] = []
    if (resume) {
      skipSourceIds = getProcessedSourceIds(dbPath, this.id)
    } else {
      // Fresh run: clear the output table
      await deleteFilter(dbPath, this.id)
      await createFilter(dbPath, this.id)
    }

    // Record that this filter run is in progress
    try {
      upsertFilterRun(dbPath, this.id, JSON.stringify(this.params), maxFiles)
    } catch (err) {
      console.error('Failed to record filter run:', err)
    }

    if (maxFiles === 0) {
      this.isProcessed = true
      return { terminated: false, errors: [] }
    }

    const minThreads = Math.max(1, numFilterThreads)
    const threadCount =
      this.type === 'sort' ? 1 : Math.min(minThreads, maxFiles)
    const slices = createSlices(maxFiles, threadCount)
    this._activeSlices = slices
    const workerResults = new Array(slices.length).fill(0)
    const workers: Worker[] = []
    const errors: string[] = []
    const logs: string[] = []
    let terminated = false
    let lastProgress = -1

    const abortHandler = () => {
      terminated = true
      workers.forEach((worker) => worker.terminate())
    }

    if (abortSignal) {
      if (abortSignal.aborted) abortHandler()
      abortSignal.addEventListener('abort', abortHandler)
    }

    eventEmitter({ current: 0, total: maxFiles })

    try {
      const workerExecArgv = getWorkerExecArgv()
      const promises = slices.map((slice, i) => {
        // Slow I/O filters (edgeguard, actionStateFilter, etc.) load full .slp
        // frame data via SlippiGame.getFrames(), which can be 20-40 MB per file.
        // Worker threads default to a small heap (~48-64 MB) so we bump it.
        const slowIOTypes = new Set([
          'slpParser',
          'actionStateFilter',
          'edgeguard',
          'reverse',
          'removeStarKOFrames',
          'koDirection',
        ])
        const resourceLimits = slowIOTypes.has(this.type)
          ? { maxOldGenerationSizeMb: 512 }
          : undefined

        const worker = new Worker(new URL('./Worker.ts', import.meta.url), {
          workerData: {
            dbPath,
            prevTableId,
            nextTableId: this.id,
            type: this.type,
            slice,
            params: this.params,
            skipSourceIds,
          },
          stderr: true,
          ...(workerExecArgv ? { execArgv: workerExecArgv } : {}),
          ...(resourceLimits ? { resourceLimits } : {}),
        })

        workers.push(worker)

        return new Promise<void>((resolve) => {
          worker.on('message', (e: WorkerMessage) => {
            if (e.type === 'progress') {
              slices[i].completed = e.current
              if (e.results !== undefined) workerResults[i] = e.results
              const totalCompleted = slices.reduce(
                (acc, s) => acc + s.completed,
                0,
              )
              if (totalCompleted !== lastProgress) {
                lastProgress = totalCompleted
                const totalResults = workerResults.reduce((a, b) => a + b, 0)
                eventEmitter({
                  current: totalCompleted,
                  total: maxFiles,
                  newItemCount: totalResults,
                })
              }
            }

            if (e.type === 'error') {
              if (errors.length < 10) errors.push(e.message)
            }

            if (e.type === 'logs') {
              if (Array.isArray(e.logs)) {
                for (const l of e.logs) {
                  if (logs.length < 500) logs.push(l)
                }
              }
            }

            if (e.type === 'done') {
              resolve()
              worker.terminate().then(() => {
                console.log('Worker terminated')
              })
            }
          })

          let workerStderr = ''
          worker.stderr?.on('data', (chunk: Buffer) => {
            workerStderr += chunk.toString()
          })

          worker.on('error', (error) => {
            console.error('Worker error:', error)
            const detail = workerStderr
              ? `${error.message}\n${workerStderr.slice(-500)}`
              : error.message
            if (errors.length < 10)
              errors.push(`Worker ${i} crashed: ${detail}`)
            resolve()
          })

          worker.on('exit', (code) => {
            if (code !== 0) {
              console.log(
                `Worker ${i} exited with code ${code}`,
                workerStderr.slice(-500),
              )
              const detail = workerStderr
                ? `Worker ${i} exited with code ${code}: ${workerStderr.slice(-500)}`
                : `Worker ${i} exited with code ${code}`
              if (errors.length < 10) errors.push(detail)
            }
            resolve()
          })
        })
      })

      await Promise.all(promises)
    } finally {
      this._activeSlices = null

      if (abortSignal) {
        abortSignal.removeEventListener('abort', abortHandler)
      }

      // Ensure all workers are terminated even if something threw
      workers.forEach((worker) => {
        try {
          worker.terminate()
        } catch (_) {
          // empty
        }
      })
    }

    if (terminated) {
      this.isProcessed = false
      // Leave run record as-is so resume is available
      return { terminated: true, errors, logs }
    }

    // Successful completion: remove run record
    deleteFilterRun(dbPath, this.id)
    this.isProcessed = true
    return { terminated: false, errors, logs }
  }
}

function createSlices(totalRows: number, numberOfSlices: number) {
  if (totalRows <= 0 || numberOfSlices <= 0) return []

  const slicesCount = Math.min(totalRows, numberOfSlices)
  const sliceSize = Math.floor(totalRows / slicesCount)
  const remainder = totalRows % slicesCount
  const slices: Slice[] = []

  let currentBottom = 1

  for (let i = 0; i < slicesCount; i += 1) {
    let currentTop = currentBottom + sliceSize - 1
    if (i < remainder) {
      currentTop += 1
    }

    slices.push({
      bottom: currentBottom,
      top: currentTop,
      completed: 0,
      id: i + 1,
    })
    currentBottom = currentTop + 1
  }

  return slices
}
