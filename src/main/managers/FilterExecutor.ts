import { BrowserWindow, IpcMainEvent } from 'electron'
import { ArchiveInterface, ConfigInterface } from '../../constants/types'
import Archive from '../../models/Archive'
import Filter from '../../models/Filter'
import {
  getMetaData,
  getTableCountAsync,
  deleteFilterRunAsync,
  updateFilterRunProgressAsync,
} from '../dbAsync'
import { track } from '../telemetry'
import { RequestEnvelope, unpackRequest, reply } from '../ipcUtils'
import { resolveInputId, getDescendantIds } from '../../lib/filterGraph'
import {
  UNAPPROVED_CODE_MESSAGE,
  unapprovedCodeHash,
} from '../customCodeApproval'
import { holdAwake } from '../powerSave'
import type ConsoleManager from './ConsoleManager'

export default class FilterExecutor {
  private mainWindow: BrowserWindow
  private getArchive: () => ArchiveInterface | null
  private setArchive: (_archive: ArchiveInterface | null) => void
  private getConfig: () => ConfigInterface
  private getLibraryFolder?: () => string
  private consoleManager: ConsoleManager
  /** The running filter's entry in the console's status zone. */
  private filterConsoleId: number | undefined

  runningFilterControllers: Map<string, AbortController>
  // Running filters by id. Positions are computed only when broadcasting, so
  // removing or reordering filters mid-run can't point the UI at the wrong card.
  runningFilterIds: Set<string>
  // Resolves when a filter's run has fully finished (results saved, reply
  // sent). Lets edits wait for a stopped run instead of racing its cleanup.
  private runDone = new Map<string, Promise<void>>()
  filterCancelIds: Set<string>
  // Runs told to stop that haven't finished winding down yet. They stay in
  // runningFilterIds (the screen shows "Stopping…") until their workers exit
  // and their partial results and resume point are saved.
  stoppingIds: Set<string> = new Set()
  activeFilter: Filter | null

  private onFilterDone?: (_filterId: string) => void

  // Async mutex for serializing filter completion metadata updates
  private _completionLocked = false
  private _completionQueue: Array<() => void> = []

  constructor(
    mainWindow: BrowserWindow,
    deps: {
      getArchive: () => ArchiveInterface | null
      setArchive: (_archive: ArchiveInterface | null) => void
      getConfig: () => ConfigInterface
      consoleManager: ConsoleManager
      /** The replay library, whose detector cache the parsers use. */
      getLibraryFolder?: () => string
      /** A run finished (not stopped) and its results are saved. */
      onFilterDone?: (_filterId: string) => void
    },
  ) {
    this.onFilterDone = deps.onFilterDone
    this.mainWindow = mainWindow
    this.getArchive = deps.getArchive
    this.setArchive = deps.setArchive
    this.getConfig = deps.getConfig
    this.getLibraryFolder = deps.getLibraryFolder
    this.consoleManager = deps.consoleManager

    this.runningFilterControllers = new Map()
    this.runningFilterIds = new Set()
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

  broadcastRunningFilters() {
    const filters = this.getArchive()?.filters ?? []
    const ids = Array.from(this.runningFilterIds)
    this.send('currentlyRunningFilter', {
      running: ids
        .map((id) => filters.findIndex((f) => f.id === id))
        .filter((i) => i >= 0),
      runningIds: ids,
      stoppingIds: Array.from(this.stoppingIds).filter((id) =>
        this.runningFilterIds.has(id),
      ),
    })
  }

  isRunning(filterId: string) {
    return this.runningFilterIds.has(filterId)
  }

  /**
   * Cancel runs (partial results are dropped) and wait until each has fully
   * finished. Call before changing a filter, its inputs or the filter list, so
   * a run's cleanup can't overwrite the change afterwards. With no ids, every
   * running filter.
   */
  async stopAndWait(filterIds?: Iterable<string>) {
    const ids = filterIds
      ? Array.from(filterIds).filter((id) => this.runningFilterIds.has(id))
      : Array.from(this.runningFilterIds)
    if (ids.length === 0) return
    for (const id of ids) {
      this.filterCancelIds.add(id)
      this.stoppingIds.add(id)
      this.runningFilterControllers.get(id)?.abort()
    }
    this.broadcastRunningFilters()
    await Promise.all(ids.map((id) => this.runDone.get(id)))
  }

  private trackRun(filterId: string, run: Promise<unknown>) {
    const done = run.then(
      () => undefined,
      () => undefined,
    )
    this.runDone.set(filterId, done)
    done.then(() => {
      if (this.runDone.get(filterId) === done) this.runDone.delete(filterId)
    })
    return run
  }

  /**
   * One run, start to finish. Always ends with exactly one reply and the
   * filter no longer shown running, whatever fails along the way (a thrown
   * database error used to leave the card "running" with no reply, and the
   * renderer never times a run out).
   */
  async _executeFilter(
    event: IpcMainEvent,
    requestId: string | undefined,
    replyChannel: string,
    filterId: string,
    resume: boolean,
  ) {
    // A run of this filter that is still going or still stopping finishes
    // first (saving its own partial results); this run then starts clean, so
    // two runs never write the same table at once. Read before trackRun
    // registers this run.
    const previous = this.runDone.get(filterId)
    const previousController = this.runningFilterControllers.get(filterId)
    if (previousController) {
      this.stoppingIds.add(filterId)
      previousController.abort()
      this.broadcastRunningFilters()
    }
    if (previous) await previous

    let replied = false
    const sendReply = (data: unknown) => {
      if (replied) return
      replied = true
      reply(event, replyChannel, requestId, data)
    }
    let own: AbortController | null = null
    // A long run: the computer must not sleep under it.
    const letSleep = holdAwake('filter')
    try {
      await this._runFilterBody(sendReply, filterId, resume, (c) => {
        own = c
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('[FilterExecutor] run failed unexpectedly:', error)
      try {
        this.consoleManager.pushConsoleLog('error', `Run failed: ${message}`)
        this.consoleManager.stopConsole(this.filterConsoleId)
        this.filterConsoleId = undefined
      } catch (_) {
        // the console is best effort
      }
      if (own && this.runningFilterControllers.get(filterId) === own) {
        this.runningFilterControllers.delete(filterId)
        this.runningFilterIds.delete(filterId)
        this.stoppingIds.delete(filterId)
        this.filterCancelIds.delete(filterId)
      }
      this.activeFilter = null
      this.broadcastRunningFilters()
      let metadata: any = null
      try {
        const path = this.getArchive()?.path
        if (path) metadata = await getMetaData(path)
      } catch (_) {
        metadata = null
      }
      sendReply(
        metadata
          ? {
              ...metadata,
              filterMessage: {
                [filterId]: 'Run failed — see the console for details',
              },
            }
          : { error: `Run failed: ${message}` },
      )
    } finally {
      letSleep()
    }
  }

  private async _runFilterBody(
    sendReply: (_data: unknown) => void,
    filterId: string,
    resume: boolean,
    onController: (_c: AbortController) => void,
  ) {
    const archive = this.getArchive()
    if (!archive) {
      return sendReply({ error: 'archive undefined' })
    }

    const filterJSON = archive.filters.find((filter) => filter.id === filterId)
    if (!filterJSON) {
      return sendReply({ error: `no filter with id: '${filterId}' found` })
    }

    // Custom code runs with the user's full privileges: it only runs when the
    // user approved exactly this code (the renderer asks; main refuses
    // otherwise, so a renderer bug or Run All cannot start unapproved code).
    if (unapprovedCodeHash(filterJSON, this.getConfig()) !== null) {
      return sendReply({ error: UNAPPROVED_CODE_MESSAGE })
    }

    // A locked step's results are fixed (types.ts): running it (one Run, Run
    // all) is a no-op that leaves the project as it is.
    if (filterJSON.locked) {
      return sendReply(await getMetaData(archive.path))
    }

    const filterIndex = archive.filters.indexOf(filterJSON)
    const filter = new Filter(filterJSON)
    if (!filter.run3) {
      return sendReply({ error: `filter creation error: '${filterId}'` })
    }

    const branchingOn = this.getConfig().branchingEnabled === true
    const prevResultsTableId = resolveInputId(
      archive.filters,
      filterIndex,
      branchingOn,
    )

    // Registered before the first await: a second Run click arriving while this
    // one waits on the database must see this run and stop it, not start beside
    // it and drop the same table twice (launch review FLT-21).
    const abortController = new AbortController()
    this.runningFilterControllers.set(filterId, abortController)
    this.runningFilterIds.add(filterId)
    this.stoppingIds.delete(filterId)
    onController(abortController)
    this.broadcastRunningFilters()

    // Fresh run: delete any existing run record (via DbWorker for WAL consistency)
    if (!resume) {
      await deleteFilterRunAsync(archive.path, filterId)
    }
    // What this run computes. If the saved params differ when it finishes, the
    // results belong to old settings and must not be marked done.
    const paramsAtStart = JSON.stringify(filterJSON.params ?? null)

    const config = this.getConfig()
    const numFilterThreads = config.numFilterThreads || 1
    this.activeFilter = filter
    this.filterConsoleId = this.consoleManager.startConsole(
      'filter',
      filterJSON.label,
    )

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
      {
        ...(resume
          ? {
              resume: true,
              resumeFromProgress: filterJSON.resumeProgress?.processed,
            }
          : {}),
        libraryFolder: this.getLibraryFolder?.(),
      },
    )
    const {
      terminated,
      failed: runFailed = false,
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

    // Games left out because they couldn't be read: a note, not a failed run.
    let skippedNote = ''
    if (missing > 0 || corrupt > 0) {
      const parts: string[] = []
      if (missing > 0)
        parts.push(
          `${missing.toLocaleString()} file(s) not found (moved/deleted)`,
        )
      if (corrupt > 0) parts.push(`${corrupt.toLocaleString()} unreadable`)
      const eg = examples.length > 0 ? ` e.g. ${examples[0]}` : ''
      // Missing files may mean an unmounted drive: that one stays an error.
      this.consoleManager.pushConsoleLog(
        missing > 0 ? 'error' : 'warn',
        `[${filterJSON.label}] ${parts.join(', ')} — skipped.${eg}`,
      )
      skippedNote = `${(missing + corrupt).toLocaleString()} ${missing + corrupt === 1 ? 'game' : 'games'} skipped (couldn’t be read)`
    }

    this.consoleManager.pushConsoleLog(
      'info',
      terminated
        ? `${filterJSON.label} cancelled`
        : `${filterJSON.label} complete`,
    )
    this.consoleManager.stopConsole(this.filterConsoleId)
    this.filterConsoleId = undefined
    if (!terminated) {
      let resultCount: number | null = null
      try {
        resultCount = await getTableCountAsync(archive.path, filterJSON.id)
      } catch {
        resultCount = null
      }
      track('filter_run', {
        filterType: filterJSON.type,
        durationMs: durationMs ?? 0,
        resultCount,
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

    // Clean up this run's controller — only if it is still ours. A second Run
    // click aborts this run and registers its own controller under the same
    // id; deleting that would leave the new run unstoppable and shown idle.
    const stillOurs =
      this.runningFilterControllers.get(filterId) === abortController
    if (stillOurs) {
      this.runningFilterControllers.delete(filterId)
      this.runningFilterIds.delete(filterId)
      this.stoppingIds.delete(filterId)
    } else {
      // Superseded by a newer run of the same filter: that run owns the output
      // table and run record now. Touch nothing; just answer this request.
      this.filterCancelIds.delete(filterId)
      const metadata = await getMetaData(archive.path)
      return sendReply(metadata)
    }

    if (terminated && this.filterCancelIds.has(filterId)) {
      // Cancel: drop partial results, reset filter, delete run record
      this.filterCancelIds.delete(filterId)
      await deleteFilterRunAsync(archive.path, filterId)
      // Reset on the CURRENT project state, found by id: the archive captured
      // at run start may be stale (other runs finished since), and saving it
      // would overwrite newer filter settings.
      const current = this.getArchive() ?? archive
      const currentIndex = current.filters.findIndex((f) => f.id === filterId)
      if (currentIndex >= 0 && current.resetFiltersFrom) {
        await current.resetFiltersFrom(currentIndex, branchingOn)
      }
      const metadata = await getMetaData(archive.path)
      this.setArchive(new Archive(metadata))
      this.broadcastRunningFilters()
      return sendReply(metadata)
    }

    // Stop: keep partial results AND run record (so resume is available)
    // Normal completion: keep results, delete run record
    // Failed (a worker crashed, or a resume could not start): like a stop —
    // partial results are kept but never marked done (Run All does the same).
    const failed = runFailed || filterErrors.length > 0
    if (failed && !filterMessage) {
      filterMessage = 'Run failed — see the console for details'
    }
    if (!failed && !filterMessage && skippedNote) filterMessage = skippedNote
    const wasStopped = terminated || failed
    if (wasStopped && lastProgress !== undefined) {
      // Save how far we got so the resume button can show it
      await updateFilterRunProgressAsync(archive.path, filterId, lastProgress)
    } else if (!wasStopped) {
      await deleteFilterRunAsync(archive.path, filterId)
    }
    this.filterCancelIds.delete(filterId)
    this.activeFilter = null

    // Serialize completion via mutex. Awaited (it never blocks the thread) so
    // this run's promise — see trackRun/stopAndWait — resolves only once its
    // results are saved and the reply is sent.
    await this.withCompletionLock(async () => {
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
          // Normal completion: mark processed, reset downstream — unless the
          // filter was edited while it ran (results are for the old params).
          const paramsChanged =
            !!refreshedFilter &&
            JSON.stringify(refreshedFilter.params ?? null) !== paramsAtStart
          if (paramsChanged) {
            this.consoleManager.pushConsoleLog(
              'warn',
              `[${filterJSON.label}] settings changed during the run — run it again`,
            )
          }
          if (refreshedFilter && !paramsChanged) {
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
        sendReply(replyData)
        this.broadcastRunningFilters()
        if (!wasStopped && refreshedFilter) this.onFilterDone?.(filterId)
      } catch (error) {
        console.error('Error finalizing filter run:', error)
        try {
          const currentArchive = this.getArchive()
          const metadata = await getMetaData(currentArchive!.path)
          this.setArchive(new Archive(metadata))
          sendReply(metadata)
        } catch (innerError) {
          console.error('Error reading metadata in recovery:', innerError)
          sendReply({ error: 'Filter completed but failed to read results' })
        }
        this.broadcastRunningFilters()
      }
    }).catch((err) => {
      console.error('Completion lock error:', err)
    })
  }

  async runFilter(event: IpcMainEvent, data: RequestEnvelope<string>) {
    const { requestId, payload } = unpackRequest<string>(data)
    return this.trackRun(
      payload!,
      this._executeFilter(event, requestId, 'runFilter', payload!, false),
    )
  }

  async resumeFilter(event: IpcMainEvent, data: RequestEnvelope<string>) {
    const { requestId, payload } = unpackRequest<string>(data)
    return this.trackRun(
      payload!,
      this._executeFilter(event, requestId, 'resumeFilter', payload!, true),
    )
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

  /**
   * Accept a stopped or failed run's results as they are: the run record (and its
   * Resume / Restart) goes away and the step counts as done. Only this filter's
   * record and flags change; its result rows, and every other step, are untouched.
   */
  async keepFilterResults(event: IpcMainEvent, data: RequestEnvelope<string>) {
    const { requestId, payload: filterId } = unpackRequest<string>(data)
    const archive = this.getArchive()
    if (!archive || !filterId) {
      return reply(event, 'keepFilterResults', requestId, {
        error: 'archive undefined',
      })
    }
    if (this.runningFilterControllers.has(filterId)) {
      return reply(event, 'keepFilterResults', requestId, {
        error: 'That step is still running.',
      })
    }
    try {
      let kept = 0
      let label = ''
      let stoppedAt = ''
      const metadata = await this.withCompletionLock(async () => {
        const fresh = new Archive(await getMetaData(archive.path))
        const filter = fresh.filters.find((f) => f.id === filterId)
        if (!filter) throw new Error('Step not found')
        label = filter.label
        if (filter.resumeProgress)
          stoppedAt = ` (stopped at ${filter.resumeProgress.processed.toLocaleString()} of ${filter.resumeProgress.totalInput.toLocaleString()})`
        kept = await getTableCountAsync(fresh.path, filterId)
        filter.isProcessed = true
        filter.results = kept
        // Mark it done first: if this fails nothing else has changed.
        if (fresh.saveMetaData) await fresh.saveMetaData()
        await deleteFilterRunAsync(fresh.path, filterId)
        this.setArchive(fresh)
        return getMetaData(fresh.path)
      })
      this.consoleManager.pushConsoleLog(
        'info',
        `[${label}] kept ${kept.toLocaleString()} results${stoppedAt}`,
      )
      this.setArchive(new Archive(metadata))
      this.broadcastRunningFilters()
      return reply(event, 'keepFilterResults', requestId, metadata)
    } catch (error) {
      console.error('[keepFilterResults] error:', error)
      return reply(event, 'keepFilterResults', requestId, {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  async cancelRunningFilters(
    event: IpcMainEvent,
    data?: RequestEnvelope<null>,
  ) {
    const { requestId } = unpackRequest<null>(data)
    // Each run finishes its own cleanup (drops partial results for a cancel);
    // until then it stays tracked and shows as stopping.
    for (const [filterId, controller] of this.runningFilterControllers) {
      this.filterCancelIds.add(filterId)
      this.stoppingIds.add(filterId)
      controller.abort()
    }
    this.broadcastRunningFilters()
    return reply(event, 'cancelRunningFilters', requestId)
  }

  async stopRunningFilters(event: IpcMainEvent, data?: RequestEnvelope<null>) {
    const { requestId } = unpackRequest<null>(data)
    for (const [filterId, controller] of this.runningFilterControllers) {
      this.stoppingIds.add(filterId)
      controller.abort()
    }
    this.broadcastRunningFilters()
    return reply(event, 'stopRunningFilters', requestId)
  }

  async stopFilter(event: IpcMainEvent, data: RequestEnvelope<string>) {
    const { requestId, payload: filterId } = unpackRequest<string>(data)
    // Stop keeps partial results and the resume point. The run stays tracked
    // ("Stopping…") until its workers have exited and those are saved:
    // forgetting it here made its cleanup think a newer run had replaced it,
    // so nothing was saved and a quick Run could overlap the dying workers.
    if (filterId) {
      const controller = this.runningFilterControllers.get(filterId)
      if (controller) {
        this.stoppingIds.add(filterId)
        controller.abort()
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
        this.stoppingIds.add(filterId)
        controller.abort()
      }
      this.broadcastRunningFilters()
    }
    return reply(event, 'cancelFilter', requestId)
  }

  cleanup() {
    for (const controller of this.runningFilterControllers.values()) {
      controller.abort()
    }
    this.runningFilterControllers.clear()
    this.runningFilterIds.clear()
    this.filterCancelIds.clear()
    this.stoppingIds.clear()
    this.activeFilter = null
  }
}
