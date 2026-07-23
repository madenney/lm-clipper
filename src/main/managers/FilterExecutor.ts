import { BrowserWindow, IpcMainEvent } from 'electron'
import { ArchiveInterface, ConfigInterface } from '../../constants/types'
import Archive from '../../models/Archive'
import Filter from '../../models/Filter'
import { getMetaData } from '../db'
import { track } from '../telemetry'
import {
  getTableCountAsync,
  deleteFilterRunAsync,
  updateFilterRunProgressAsync,
} from '../dbAsync'
import { RequestEnvelope, unpackRequest, reply } from '../ipcUtils'
import { resolveInputId, getDescendantIds } from '../../lib/filterGraph'
import type ConsoleManager from './ConsoleManager'

export default class FilterExecutor {
  private mainWindow: BrowserWindow
  private getArchive: () => ArchiveInterface | null
  private setArchive: (_archive: ArchiveInterface | null) => void
  private getArchiveVersion: () => number
  private getConfig: () => ConfigInterface
  private consoleManager: ConsoleManager

  runningFilterControllers: Map<string, AbortController>
  runningFilterIndices: Set<number>
  filterCancelIds: Set<string>
  activeFilter: Filter | null

  // Async mutex for serializing filter completion metadata updates
  private _completionLocked = false
  private _completionQueue: Array<() => void> = []

  constructor(
    mainWindow: BrowserWindow,
    deps: {
      getArchive: () => ArchiveInterface | null
      setArchive: (_archive: ArchiveInterface | null) => void
      getArchiveVersion: () => number
      getConfig: () => ConfigInterface
      consoleManager: ConsoleManager
    },
  ) {
    this.mainWindow = mainWindow
    this.getArchive = deps.getArchive
    this.setArchive = deps.setArchive
    this.getArchiveVersion = deps.getArchiveVersion
    this.getConfig = deps.getConfig
    this.consoleManager = deps.consoleManager

    this.runningFilterControllers = new Map()
    this.runningFilterIndices = new Set()
    this.filterCancelIds = new Set()
    this.activeFilter = null
  }

  private async withCompletionLock<T>(fn: () => Promise<T>): Promise<T> {
    if (this._completionLocked) {
      await new Promise<void>((resolve) => {
        this._completionQueue.push(resolve)
      })
    }
    this._completionLocked = true
    try {
      return await fn()
    } finally {
      this._completionLocked = false
      const next = this._completionQueue.shift()
      if (next) next()
    }
  }

  // Guarded send: workers can outlive the window (e.g. a resume still running
  // when the window is closed/reloaded). Sending to a destroyed webContents
  // throws "Object has been destroyed", which surfaced as a crash dialog that
  // kept reappearing. Drop the message instead.
  private send(channel: string, payload: unknown) {
    if (this.mainWindow?.isDestroyed?.()) return
    if (this.mainWindow?.webContents?.isDestroyed?.()) return
    this.mainWindow.webContents.send(channel, payload)
  }

  private broadcastRunningFilters() {
    this.send('currentlyRunningFilter', {
      running: Array.from(this.runningFilterIndices),
    })
  }

  async _executeFilter(
    event: IpcMainEvent,
    requestId: string | undefined,
    replyChannel: string,
    filterId: string,
    resume: boolean,
  ) {
    const archive = this.getArchive()
    if (!archive) {
      return reply(event, replyChannel, requestId, {
        error: 'archive undefined',
      })
    }

    const filterJSON = archive.filters.find((filter) => filter.id === filterId)
    if (!filterJSON) {
      return reply(event, replyChannel, requestId, {
        error: `no filter with id: '${filterId}' found`,
      })
    }

    const filterIndex = archive.filters.indexOf(filterJSON)
    const filter = new Filter(filterJSON)
    if (!filter.run3) {
      return reply(event, replyChannel, requestId, {
        error: `filter creation error: '${filterId}'`,
      })
    }

    const branchingOn = this.getConfig().branchingEnabled === true
    const prevResultsTableId = resolveInputId(
      archive.filters,
      filterIndex,
      branchingOn,
    )

    // If this filter is already running, abort it first
    const existingController = this.runningFilterControllers.get(filterId)
    if (existingController) {
      existingController.abort()
      this.runningFilterControllers.delete(filterId)
    }

    // Fresh run: delete any existing run record (via DbWorker for WAL consistency)
    if (!resume) {
      await deleteFilterRunAsync(archive.path, filterId)
    }

    const abortController = new AbortController()
    this.runningFilterControllers.set(filterId, abortController)
    this.runningFilterIndices.add(filterIndex)
    this.broadcastRunningFilters()

    const config = this.getConfig()
    const numFilterThreads = config.numFilterThreads || 1
    this.activeFilter = filter
    this.consoleManager.startConsole('filter', filterJSON.label)

    const filterResult = await filter.run3(
      archive.path,
      prevResultsTableId,
      numFilterThreads,
      (eventUpdate: {
        current: number
        total: number
        newItemCount?: number
      }) => {
        const { total, current, newItemCount } = eventUpdate
        this.send('filterUpdate', {
          filterId,
          filterIndex,
          total,
          current,
          results: newItemCount,
        })
      },
      abortController.signal,
      resume
        ? {
            resume: true,
            resumeFromProgress: filterJSON.resumeProgress?.processed,
          }
        : undefined,
    )
    const {
      terminated,
      errors: filterErrors,
      logs: filterLogs,
      lastProgress,
      missing = 0,
      corrupt = 0,
      examples = [],
      durationMs,
    } = filterResult

    if (filterErrors.length > 0) {
      this.send('filterError', {
        filterId,
        filterLabel: filterJSON.label,
        errors: filterErrors,
      })
      for (const err of filterErrors) {
        this.consoleManager.pushConsoleLog(
          'error',
          `[${filterJSON.label}] ${err}`,
        )
      }
    }

    if (filterLogs && filterLogs.length > 0) {
      this.send('filterLogs', {
        filterId,
        filterLabel: filterJSON.label,
        logs: filterLogs,
      })
      for (const l of filterLogs) {
        this.consoleManager.pushConsoleLog('info', `[${filterJSON.label}] ${l}`)
      }
    }

    if (missing > 0 || corrupt > 0) {
      const parts: string[] = []
      if (missing > 0)
        parts.push(
          `${missing.toLocaleString()} file(s) not found (moved/deleted)`,
        )
      if (corrupt > 0) parts.push(`${corrupt.toLocaleString()} unreadable`)
      const eg = examples.length > 0 ? ` e.g. ${examples[0]}` : ''
      this.consoleManager.pushConsoleLog(
        'error',
        `[${filterJSON.label}] ${parts.join(', ')} — skipped.${eg}`,
      )
    }

    this.consoleManager.pushConsoleLog(
      'info',
      terminated
        ? `${filterJSON.label} cancelled`
        : `${filterJSON.label} complete`,
    )
    this.consoleManager.stopConsole()
    if (!terminated) {
      track('filter_run', {
        filterType: filterJSON.type,
        durationMs: durationMs ?? 0,
      })
    }

    // Check if upstream filter is still running (before cleanup)
    let filterMessage = ''
    if (filterIndex > 0) {
      const currentArchive = this.getArchive()
      const prevFilterId = currentArchive
        ? resolveInputId(currentArchive.filters, filterIndex, branchingOn)
        : undefined
      if (
        prevFilterId &&
        prevFilterId !== 'files' &&
        this.runningFilterControllers.has(prevFilterId)
      ) {
        try {
          const prevCount = await getTableCountAsync(archive.path, prevFilterId)
          filterMessage =
            prevCount === 0
              ? 'Previous filter has no results yet'
              : `Ran on ${prevCount.toLocaleString()} partial results`
        } catch (_) {
          filterMessage = 'Previous filter has no results yet'
        }
      }
    }

    // Clean up this filter's controller
    this.runningFilterControllers.delete(filterId)
    this.runningFilterIndices.delete(filterIndex)

    if (terminated && this.filterCancelIds.has(filterId)) {
      // Cancel: drop partial results, reset filter, delete run record
      this.filterCancelIds.delete(filterId)
      await deleteFilterRunAsync(archive.path, filterId)
      if (archive.resetFiltersFrom) {
        await archive.resetFiltersFrom(filterIndex, branchingOn)
      }
      const metadata = await getMetaData(archive.path)
      this.setArchive(new Archive(metadata))
      this.broadcastRunningFilters()
      return reply(event, replyChannel, requestId, metadata)
    }

    // Stop: keep partial results AND run record (so resume is available)
    // Normal completion: keep results, delete run record
    const wasStopped = terminated
    if (wasStopped && lastProgress !== undefined) {
      // Save how far we got so the resume button can show it
      await updateFilterRunProgressAsync(archive.path, filterId, lastProgress)
    } else if (!wasStopped) {
      await deleteFilterRunAsync(archive.path, filterId)
    }
    this.filterCancelIds.delete(filterId)
    this.activeFilter = null

    // Fire-and-forget: serialize completion via mutex, don't block IPC handler
    this.withCompletionLock(async () => {
      try {
        // Re-read archive from DB since another filter may have finished concurrently
        const freshArchive = this.getArchive()
        if (!freshArchive) return
        const freshMetadata = await getMetaData(freshArchive.path)
        const newArchive = new Archive(freshMetadata)

        const refreshedFilter = newArchive.filters.find(
          (f) => f.id === filterId,
        )

        if (wasStopped) {
          // Stopped: keep partial results, don't mark processed
          // Get accurate partial count
          if (refreshedFilter) {
            refreshedFilter.results = await getTableCountAsync(
              newArchive.path,
              filterId,
            )
          }
        } else {
          // Normal completion: mark processed, reset downstream
          if (refreshedFilter) {
            refreshedFilter.isProcessed = true
            if (typeof durationMs === 'number') {
              refreshedFilter.lastRunMs = durationMs
            }
          }

          // Only invalidate filters that actually read from this one (directly
          // or transitively). In a plain linear chain that's "everything below";
          // with branches it leaves unrelated branches untouched.
          const descendants = getDescendantIds(
            newArchive.filters,
            filterId,
            branchingOn,
          )
          for (const df of newArchive.filters) {
            if (
              descendants.has(df.id) &&
              !this.runningFilterControllers.has(df.id)
            ) {
              df.isProcessed = false
              df.results = 0
            }
          }

          // Get accurate final count
          if (refreshedFilter) {
            refreshedFilter.results = await getTableCountAsync(
              newArchive.path,
              filterId,
            )
          }
        }

        // Save to DB first, then update in-memory state
        if (newArchive.saveMetaData) await newArchive.saveMetaData()

        // Set in-memory archive only after successful DB save
        this.setArchive(newArchive)

        const metadata = {
          name: newArchive.name,
          path: newArchive.path,
          createdAt: newArchive.createdAt,
          files: newArchive.files,
          filters: newArchive.filters,
          savedCustomFilters: (newArchive as any).savedCustomFilters || [],
        }
        const replyData = filterMessage
          ? { ...metadata, filterMessage: { [filterId]: filterMessage } }
          : metadata
        reply(event, replyChannel, requestId, replyData)
        this.broadcastRunningFilters()
      } catch (error) {
        console.error('Error finalizing filter run:', error)
        try {
          const currentArchive = this.getArchive()
          const metadata = await getMetaData(currentArchive!.path)
          this.setArchive(new Archive(metadata))
          reply(event, replyChannel, requestId, metadata)
        } catch (innerError) {
          console.error('Error reading metadata in recovery:', innerError)
          reply(event, replyChannel, requestId, {
            error: 'Filter completed but failed to read results',
          })
        }
        this.broadcastRunningFilters()
      }
    }).catch((err) => {
      console.error('Completion lock error:', err)
    })
  }

  async runFilter(event: IpcMainEvent, data: RequestEnvelope<string>) {
    const { requestId, payload } = unpackRequest<string>(data)
    return this._executeFilter(event, requestId, 'runFilter', payload!, false)
  }

  async resumeFilter(event: IpcMainEvent, data: RequestEnvelope<string>) {
    const { requestId, payload } = unpackRequest<string>(data)
    return this._executeFilter(event, requestId, 'resumeFilter', payload!, true)
  }

  async dismissFilterResume(
    event: IpcMainEvent,
    data: RequestEnvelope<string>,
  ) {
    const { requestId, payload: filterId } = unpackRequest<string>(data)
    const archive = this.getArchive()
    if (!archive || !filterId) {
      return reply(event, 'dismissFilterResume', requestId, {
        error: 'archive undefined',
      })
    }

    try {
      // Delete the run record on the same DB connection that getMetaData reads from
      // (both go through DbWorker, so the delete is visible to the subsequent read)
      console.log(
        '[dismissFilterResume] deleting run for:',
        filterId,
        'at path:',
        archive.path,
      )
      await deleteFilterRunAsync(archive.path, filterId)
      console.log('[dismissFilterResume] delete completed, refreshing metadata')
      const metadata = await getMetaData(archive.path)
      const stillResumable = metadata?.filters?.filter((f: any) => f.resumable)
      console.log(
        '[dismissFilterResume] still resumable after refresh:',
        JSON.stringify(
          stillResumable?.map((f: any) => ({ id: f.id, label: f.label })),
        ),
      )
      this.setArchive(new Archive(metadata))
      return reply(event, 'dismissFilterResume', requestId, metadata)
    } catch (error) {
      console.error('[dismissFilterResume] error:', error)
      return reply(event, 'dismissFilterResume', requestId, {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  async runFilters(event: IpcMainEvent, data?: RequestEnvelope<null>) {
    const { requestId } = unpackRequest<null>(data)
    const archive = this.getArchive()
    if (!archive || !archive.shallowCopy) {
      return reply(event, 'runFilters', requestId, {
        error: 'archive undefined',
      })
    }

    const config = this.getConfig()
    const numFilterThreads = config.numFilterThreads || 1
    const branchingOn = config.branchingEnabled === true
    const batchAbort = new AbortController()

    for (let i = 0; i < archive.filters.length; i += 1) {
      const filterJSON = archive.filters[i]
      const prevResultsTableId = resolveInputId(archive.filters, i, branchingOn)
      const filter = new Filter(filterJSON)
      this.activeFilter = filter
      this.consoleManager.startConsole('filter', filterJSON.label)

      this.runningFilterControllers.set(filterJSON.id, batchAbort)
      this.runningFilterIndices.add(i)
      this.broadcastRunningFilters()

      const filterResult = await filter.run3(
        archive.path,
        prevResultsTableId,
        numFilterThreads,
        (eventUpdate: { current: number; total: number }) => {
          const { total, current } = eventUpdate
          this.send('filterUpdate', {
            filterId: filterJSON.id,
            filterIndex: i,
            total,
            current,
          })
        },
        batchAbort.signal,
      )
      const {
        terminated,
        errors: filterErrors,
        logs: filterLogs,
        durationMs,
      } = filterResult

      if (filterErrors.length > 0) {
        this.send('filterError', {
          filterId: filterJSON.id,
          filterLabel: filterJSON.label,
          errors: filterErrors,
        })
      }

      if (filterLogs && filterLogs.length > 0) {
        this.send('filterLogs', {
          filterId: filterJSON.id,
          filterLabel: filterJSON.label,
          logs: filterLogs,
        })
      }

      // A populated `errors` means a worker crashed / exited non-zero (see
      // Filter.run3) — the filter's output table is only partially written.
      // Treat it like a cancel: halt the batch and DON'T mark this (or anything
      // downstream) processed, so the chain never reports success on truncated
      // data.
      const failed = filterErrors.length > 0
      this.consoleManager.pushConsoleLog(
        terminated || failed ? 'warn' : 'info',
        // eslint-disable-next-line no-nested-ternary
        terminated
          ? `${filterJSON.label} cancelled`
          : failed
            ? `${filterJSON.label} failed — stopping Run All`
            : `${filterJSON.label} complete`,
      )
      this.consoleManager.stopConsole()
      if (!terminated && !failed) {
        // Run All executes the same work as a single run, so it reports the
        // same event — otherwise every filter run started from "Run All" (the
        // common path) is invisible to telemetry.
        track('filter_run', {
          filterType: filterJSON.type,
          durationMs: durationMs ?? 0,
        })
      }

      this.runningFilterControllers.delete(filterJSON.id)
      this.runningFilterIndices.delete(i)
      this.broadcastRunningFilters()

      if (terminated || batchAbort.signal.aborted || failed) {
        if (archive.resetFiltersFrom) {
          await archive.resetFiltersFrom(i, branchingOn)
        }
        break
      }

      filterJSON.isProcessed = true
      filterJSON.results = 0
      if (typeof durationMs === 'number') filterJSON.lastRunMs = durationMs
    }

    if (archive.saveMetaData) await archive.saveMetaData()

    const metadata = await getMetaData(archive.path)
    this.setArchive(new Archive(metadata))

    return reply(event, 'runFilters', requestId, metadata)
  }

  async cancelRunningFilters(
    event: IpcMainEvent,
    data?: RequestEnvelope<null>,
  ) {
    const { requestId } = unpackRequest<null>(data)
    for (const [filterId, controller] of this.runningFilterControllers) {
      this.filterCancelIds.add(filterId)
      controller.abort()
    }
    this.runningFilterControllers.clear()
    this.runningFilterIndices.clear()
    this.broadcastRunningFilters()
    return reply(event, 'cancelRunningFilters', requestId)
  }

  async stopRunningFilters(event: IpcMainEvent, data?: RequestEnvelope<null>) {
    const { requestId } = unpackRequest<null>(data)
    for (const controller of this.runningFilterControllers.values()) {
      controller.abort()
    }
    this.runningFilterControllers.clear()
    this.runningFilterIndices.clear()
    this.broadcastRunningFilters()
    return reply(event, 'stopRunningFilters', requestId)
  }

  async stopFilter(event: IpcMainEvent, data: RequestEnvelope<string>) {
    const { requestId, payload: filterId } = unpackRequest<string>(data)
    if (filterId) {
      const controller = this.runningFilterControllers.get(filterId)
      if (controller) {
        controller.abort()
        this.runningFilterControllers.delete(filterId)
      }
      const archive = this.getArchive()
      if (archive) {
        const filterIndex = archive.filters.findIndex((f) => f.id === filterId)
        if (filterIndex >= 0) {
          this.runningFilterIndices.delete(filterIndex)
        }
      }
      this.broadcastRunningFilters()
    }
    return reply(event, 'stopFilter', requestId)
  }

  async cancelFilter(event: IpcMainEvent, data: RequestEnvelope<string>) {
    const { requestId, payload: filterId } = unpackRequest<string>(data)
    if (filterId) {
      this.filterCancelIds.add(filterId)
      const controller = this.runningFilterControllers.get(filterId)
      if (controller) {
        controller.abort()
      }
    }
    return reply(event, 'cancelFilter', requestId)
  }

  cleanup() {
    for (const controller of this.runningFilterControllers.values()) {
      controller.abort()
    }
    this.runningFilterControllers.clear()
    this.runningFilterIndices.clear()
    this.filterCancelIds.clear()
    this.activeFilter = null
  }
}
