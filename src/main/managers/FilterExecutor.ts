import { BrowserWindow, IpcMainEvent } from 'electron'
import { ArchiveInterface, ConfigInterface } from '../../constants/types'
import Archive from '../../models/Archive'
import Filter from '../../models/Filter'
import { getMetaData, deleteFilterRun } from '../db'
import { RequestEnvelope, unpackRequest, reply } from '../ipcUtils'
import type ConsoleManager from './ConsoleManager'

export default class FilterExecutor {
  private mainWindow: BrowserWindow
  private getArchive: () => ArchiveInterface | null
  private setArchive: (_archive: ArchiveInterface | null) => void
  private getConfig: () => ConfigInterface
  private consoleManager: ConsoleManager

  runningFilterControllers: Map<string, AbortController>
  runningFilterIndices: Set<number>
  filterCancelIds: Set<string>
  private filterCompletionLock: Promise<void>
  activeFilter: Filter | null

  constructor(
    mainWindow: BrowserWindow,
    deps: {
      getArchive: () => ArchiveInterface | null
      setArchive: (_archive: ArchiveInterface | null) => void
      getConfig: () => ConfigInterface
      consoleManager: ConsoleManager
    },
  ) {
    this.mainWindow = mainWindow
    this.getArchive = deps.getArchive
    this.setArchive = deps.setArchive
    this.getConfig = deps.getConfig
    this.consoleManager = deps.consoleManager

    this.runningFilterControllers = new Map()
    this.runningFilterIndices = new Set()
    this.filterCancelIds = new Set()
    this.filterCompletionLock = Promise.resolve()
    this.activeFilter = null
  }

  private broadcastRunningFilters() {
    if (this.mainWindow?.isDestroyed?.()) return
    this.mainWindow.webContents.send('currentlyRunningFilter', {
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

    const prevResultsTableId =
      filterIndex === 0 ? 'files' : archive.filters[filterIndex - 1].id

    // If this filter is already running, abort it first
    const existingController = this.runningFilterControllers.get(filterId)
    if (existingController) {
      existingController.abort()
      this.runningFilterControllers.delete(filterId)
    }

    // Fresh run: delete any existing run record
    if (!resume) {
      deleteFilterRun(archive.path, filterId)
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
        this.mainWindow.webContents.send('filterUpdate', {
          filterId,
          filterIndex,
          total,
          current,
          results: newItemCount,
        })
      },
      abortController.signal,
      resume ? { resume: true } : undefined,
    )
    const { terminated, errors: filterErrors, logs: filterLogs } = filterResult

    if (filterErrors.length > 0) {
      this.mainWindow.webContents.send('filterError', {
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
      this.mainWindow.webContents.send('filterLogs', {
        filterId,
        filterLabel: filterJSON.label,
        logs: filterLogs,
      })
      for (const l of filterLogs) {
        this.consoleManager.pushConsoleLog('info', `[${filterJSON.label}] ${l}`)
      }
    }

    this.consoleManager.pushConsoleLog(
      'info',
      terminated
        ? `${filterJSON.label} cancelled`
        : `${filterJSON.label} complete`,
    )
    this.consoleManager.stopConsole()

    // Check if upstream filter is still running (before cleanup)
    let filterMessage = ''
    if (filterIndex > 0) {
      const currentArchive = this.getArchive()
      const prevFilterId = currentArchive?.filters[filterIndex - 1]?.id
      if (prevFilterId && this.runningFilterControllers.has(prevFilterId)) {
        try {
          const { getTableCount } = await import('../db')
          const prevCount = getTableCount(archive.path, prevFilterId)
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
      deleteFilterRun(archive.path, filterId)
      if (archive.resetFiltersFrom) {
        await archive.resetFiltersFrom(filterIndex)
      }
      const metadata = await getMetaData(archive.path)
      this.setArchive(new Archive(metadata))
      this.broadcastRunningFilters()
      return reply(event, replyChannel, requestId, metadata)
    }

    // Stop or normal completion: keep results, mark processed
    this.filterCancelIds.delete(filterId)

    // Serialize concurrent filter completions to prevent race conditions
    // .catch() ensures a prior rejection doesn't break the chain
    this.filterCompletionLock = this.filterCompletionLock
      .catch(() => {})
      .then(async () => {
        try {
          // Re-read archive from DB since another filter may have finished concurrently
          const freshArchive = this.getArchive()
          if (!freshArchive) return
          const freshMetadata = await getMetaData(freshArchive.path)
          const newArchive = new Archive(freshMetadata)
          this.setArchive(newArchive)

          // Find the filter again in the refreshed archive and mark it processed
          const refreshedFilter = newArchive.filters.find(
            (f) => f.id === filterId,
          )
          if (refreshedFilter) {
            refreshedFilter.isProcessed = true
          }

          // Reset downstream filters that are NOT currently running
          const refreshedIndex = newArchive.filters.findIndex(
            (f) => f.id === filterId,
          )
          if (
            refreshedIndex >= 0 &&
            refreshedIndex + 1 < newArchive.filters.length
          ) {
            const downstream = newArchive.filters.slice(refreshedIndex + 1)
            for (const df of downstream) {
              if (!this.runningFilterControllers.has(df.id)) {
                df.isProcessed = false
                df.results = 0
              }
            }
          }

          if (newArchive.saveMetaData) await newArchive.saveMetaData()

          const metadata = await getMetaData(newArchive.path)
          const finalArchive = new Archive(metadata)
          this.setArchive(finalArchive)

          const replyData = filterMessage
            ? { ...metadata, filterMessage: { [filterId]: filterMessage } }
            : metadata
          // Reply first so UI has correct results before isRunning flips to false
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
      })
    this.activeFilter = null
    await this.filterCompletionLock
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

    // Delete the run record (keep partial results)
    deleteFilterRun(archive.path, filterId)

    // Refresh archive
    const metadata = await getMetaData(archive.path)
    this.setArchive(new Archive(metadata))
    return reply(event, 'dismissFilterResume', requestId, metadata)
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
    const batchAbort = new AbortController()

    let prevResultsTableId = 'files'
    for (let i = 0; i < archive.filters.length; i += 1) {
      const filterJSON = archive.filters[i]
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
          this.mainWindow.webContents.send('filterUpdate', {
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
      } = filterResult

      if (filterErrors.length > 0) {
        this.mainWindow.webContents.send('filterError', {
          filterId: filterJSON.id,
          filterLabel: filterJSON.label,
          errors: filterErrors,
        })
      }

      if (filterLogs && filterLogs.length > 0) {
        this.mainWindow.webContents.send('filterLogs', {
          filterId: filterJSON.id,
          filterLabel: filterJSON.label,
          logs: filterLogs,
        })
      }

      this.consoleManager.pushConsoleLog(
        terminated ? 'warn' : 'info',
        terminated
          ? `${filterJSON.label} cancelled`
          : `${filterJSON.label} complete`,
      )
      this.consoleManager.stopConsole()

      this.runningFilterControllers.delete(filterJSON.id)
      this.runningFilterIndices.delete(i)
      this.broadcastRunningFilters()

      if (terminated || batchAbort.signal.aborted) {
        if (archive.resetFiltersFrom) {
          await archive.resetFiltersFrom(i)
        }
        break
      }

      filterJSON.isProcessed = true
      filterJSON.results = 0
      prevResultsTableId = filterJSON.id
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
