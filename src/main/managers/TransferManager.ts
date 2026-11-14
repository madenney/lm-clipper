import { app, BrowserWindow, dialog, IpcMainEvent, shell } from 'electron'
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { askDialog } from '../askRenderer'
import {
  DatabaseFilters,
  DatabaseReplay,
  DatabaseRequest,
  Transfer,
  parseDatabaseEstimate,
  parseSiteStatus,
  formatWait,
  parsePlayerSuggestions,
  parseTournamentSuggestions,
  parseDatabaseRequest,
  databaseExportFilter,
  databaseSearchBody,
  validateDatabaseFilters,
  ONE_BY_ONE_MAX_GAMES,
  estimateFromStored,
  parseDirectCounts,
  parseFullDbInfo,
} from '../../constants/database'
import {
  ClipSearchReply,
  findClipsBody,
  parseClipRequest,
} from '../../constants/clipSearch'
import { shownProjectName } from '../../constants/defaultProject'
import {
  DatabaseClient,
  DatabaseRequestError,
  storageUrlAllowed,
} from '../databaseClient'
import type { ReplayInfo } from '../../constants/replayInfo'
import { reply, unpackRequest } from '../ipcUtils'
import {
  loadSavedTransfersDetailed,
  writeSavedTransfers,
} from '../transfers/persistence'
import { logMain } from '../logger'
import { holdAwake } from '../powerSave'
import { defaultReplaysFolder } from '../dataLocations'
import { compareVersions } from '../../lib/changelog'
import { logStage } from '../transfers/stageLog'
import { replayInfo } from '../transfers/replayInfo'
import { runJob } from '../transfers/runJob'
import {
  addClips,
  addReplays,
  queueFullDb,
  queueJob,
  unpackFile,
} from '../transfers/queueJobs'
import type { TransferContext, TransferDeps } from '../transfers/context'
import {
  ExportGoneError,
  MaintenanceError,
  RetryLaterError,
  classifyRemoteError,
  isMaintenanceError,
  maintenanceDetail,
} from '../transfers/errors'
import { discardPartial } from '../transfers/files'
import {
  parseSavedTransfer,
  recoverTransfer,
  type SavedTransfer,
} from '../transfers/savedTransfer'

export { formatWait }

const RELOCATED_FIELDS = [
  'outputDir',
  'preparedPath',
  'gamesFile',
  'clipsFile',
  'directFiles',
] as const

/** Point every path under `oldFolder` at `newFolder`; true when any changed. */
export function relocateJobs(
  jobs: SavedTransfer[],
  oldFolder: string,
  newFolder: string,
): boolean {
  const from = `${path.resolve(oldFolder)}${path.sep}`
  const to = `${path.resolve(newFolder)}${path.sep}`
  const move = (p: string) =>
    p.startsWith(from) ? to + p.slice(from.length) : p
  let changed = false
  for (const job of jobs) {
    for (const key of RELOCATED_FIELDS) {
      const value = job[key]
      if (typeof value !== 'string') continue
      const moved = move(value)
      if (moved !== value) {
        job[key] = moved
        changed = true
      }
    }
  }
  return changed
}

// Everything below used to live in this file; re-exported so imports stay valid.
export {
  ExportGoneError,
  RetryLaterError,
  MaintenanceError,
  maintenanceDetail,
  isMaintenanceError,
  isNetworkError,
  networkErrorMessage,
  classifyRemoteError,
} from '../transfers/errors'
export {
  type RemoteStatus,
  describeRemoteStatus,
  readyAtOf,
  interpretStatus,
} from '../transfers/remoteStatus'
export {
  isInside,
  realPath,
  removeUnfinishedAttempts,
  preparedImportPaths,
  importSummary,
} from '../transfers/files'
export { parseSavedTransfer, recoverTransfer }

/** How often paused-for-maintenance transfers check whether the database is back. */
const MAINTENANCE_POLL_MS = 30_000

export default class TransferManager {
  private jobs: SavedTransfer[] = []
  private active?: { id: string; abort: AbortController }
  private closed = false
  private loadError?: string
  private lastBroadcast = 0
  private statePath: string
  private client: DatabaseClient

  constructor(
    private _window: BrowserWindow,
    private deps: TransferDeps,
  ) {
    this.statePath = path.join(deps.configDir, 'transfers.json')
    this.client = new DatabaseClient(
      !app.isPackaged && process.env.LUNAR_DATABASE_ORIGIN
        ? process.env.LUNAR_DATABASE_ORIGIN
        : 'https://www.lunarmelee.com',
    )
    // Development only (never a packaged build): a local stand-in for storage, for
    // end-to-end runs against a local website and database (direct downloads read
    // ranges from it, and the prebuilt plans' manifest is looked for there).
    const devStorage = !app.isPackaged && process.env.LUNAR_STORAGE_ORIGIN
    if (devStorage && !deps.direct?.allowUrl) {
      const origin = new URL(devStorage).origin
      this.deps = {
        ...deps,
        direct: {
          ...deps.direct,
          allowUrl: (u) => storageUrlAllowed(u) || u.startsWith(`${origin}/`),
          plansUrl: deps.direct?.plansUrl ?? `${origin}/plans/v1/manifest.json`,
        },
      }
    }
    try {
      const saved = loadSavedTransfersDetailed(this.statePath)
      if (saved) {
        this.jobs = saved.jobs
        if (saved.skipped)
          logMain('transfers: records left out of the history', {
            skipped: saved.skipped,
            kept: `${this.statePath}.bad`,
          })
      }
    } catch (error) {
      // Not a transfer history at all. Keep the file aside (never delete it)
      // and start a clean list rather than disabling every download.
      try {
        fs.renameSync(this.statePath, `${this.statePath}.corrupt-${Date.now()}`)
        logMain('transfers.json set aside', { error: String(error) })
      } catch {
        this.loadError =
          'Download history could not be read. Your replay files are untouched. Restore or rename transfers.json in the application settings folder before starting another download.'
      }
    }
    // Closed while the database was down for maintenance: keep watching for its return.
    if (this.jobs.some((j) => j.waitingForDatabase)) this.watchMaintenance()
  }

  private replayInfoCache = new Map<string, ReplayInfo | null>()

  /** What the download runners get of this manager (transfers/context.ts). */
  private ctx: TransferContext = this.makeContext()

  private makeContext(): TransferContext {
    const m = this
    return {
      get client() {
        return m.client
      },
      get deps() {
        return m.deps
      },
      get window() {
        return m._window
      },
      get jobs() {
        return m.jobs
      },
      update: (job, patch, persist) => m.update(job, patch, persist),
      save: () => m.save(),
    }
  }

  private maintenanceTimer?: ReturnType<typeof setTimeout>

  /**
   * The database is down for maintenance: park this transfer and every other
   * queued database transfer (nothing on disk is discarded), and check
   * /api/status until it's back, then queue them again.
   */
  private pauseForMaintenance(job: SavedTransfer, message: string) {
    const detail = maintenanceDetail(message)
    this.update(job, {
      stage: 'paused',
      error: undefined,
      waitingForDatabase: true,
      detail,
    })
    for (const other of this.jobs)
      if (
        other !== job &&
        other.kind === 'database' &&
        other.stage === 'queued'
      )
        this.update(other, {
          stage: 'paused',
          waitingForDatabase: true,
          detail,
        })
    this.watchMaintenance()
  }

  private watchMaintenance() {
    if (this.maintenanceTimer || this.closed) return
    const ms = this.deps.maintenancePollMs ?? MAINTENANCE_POLL_MS
    const tick = async () => {
      this.maintenanceTimer = undefined
      if (this.closed) return
      if (!this.jobs.some((j) => j.waitingForDatabase)) return
      let back = false
      try {
        const status = parseSiteStatus(await this.client.json('/api/status'))
        back = !!status && !status.maintenance && status.database === 'up'
      } catch {
        back = false
      }
      if (this.closed) return
      if (!back) {
        this.maintenanceTimer = setTimeout(tick, ms)
        return
      }
      for (const j of this.jobs.filter((x) => x.waitingForDatabase))
        this.update(
          j,
          j.stage === 'paused'
            ? {
                stage: 'queued',
                waitingForDatabase: undefined,
                detail: 'The database is back. Resuming…',
              }
            : { waitingForDatabase: undefined },
        )
      this.pump()
    }
    this.maintenanceTimer = setTimeout(tick, ms)
  }

  list(): Transfer[] {
    return this.jobs.map(
      ({
        filters: _filters,
        replayIds: _replayIds,
        clipsFile: _clipsFile,
        gamesFile: _gamesFile,
        sources: _sources,
        token: _token,
        remoteId: _remoteId,
        fullDbDownloadId: _fullDbDownloadId,
        fullDbToken: _fullDbToken,
        direct: _direct,
        directFiles: _directFiles,
        storedOnly: _storedOnly,
        notStored: _notStored,
        unreadable: _unreadable,
        spaceOk: _spaceOk,
        preparedPath,
        ...publicJob
      }) => ({
        ...publicJob,
        // Finished with its replays on disk: can be added to another project.
        canImport: publicJob.stage === 'completed' && !!preparedPath,
        saved: this.savedSoFar(publicJob.id),
      }),
    )
  }

  private savedCache = new Map<
    string,
    { key: string; value: Transfer['saved'] }
  >()

  /** What a waiting/stopped job already has on disk ("Nothing downloaded yet"
   *  otherwise). Not for running or finished jobs: their progress bar and result
   *  say it. Cached until the job's stage changes. */
  private savedSoFar(id: string): Transfer['saved'] {
    const job = this.jobs.find((j) => j.id === id)
    if (
      !job ||
      job.stage === 'completed' ||
      job.stage === 'downloading' ||
      job.stage === 'extracting' ||
      job.stage === 'importing'
    )
      return undefined
    // Not the detail: it changes with every page of a preparing job, and the
    // answer only changes when the stage does.
    const key = `${job.stage}|${job.replayIds?.length ?? 0}`
    const hit = this.savedCache.get(id)
    if (hit && hit.key === key) return hit.value
    let bytes = 0
    const files = job.file
      ? [`${job.file}.part`]
      : ['download.zip', 'download.zip.part'].map((n) =>
          path.join(job.outputDir, n),
        )
    for (const name of files)
      try {
        bytes += fs.statSync(name).size
      } catch {
        /* not there */
      }
    const value: NonNullable<Transfer['saved']> = { bytes, games: null }
    this.savedCache.set(id, { key, value })
    // The games already in the library, asked of the library worker (never
    // better-sqlite3 on this thread); the answer is broadcast when it arrives.
    if (job.replayIds?.length)
      this.deps
        .getLibrary()
        .lookup(job.replayIds, [])
        .then(({ have }) => {
          value.games = Object.keys(have).length
          if (!this.closed) this.broadcast(true)
        })
        .catch(() => {})
    return value
  }

  /** Jobs canceled while running: marked and cleaned up once they stop. */
  private canceling = new Set<string>()

  private async canceledDetail(job: SavedTransfer) {
    let kept = 0
    if (job.replayIds?.length)
      try {
        const { have } = await this.deps.getLibrary().lookup(job.replayIds, [])
        kept = Object.keys(have).length
      } catch {
        kept = 0
      }
    return kept
      ? `Canceled. The ${kept.toLocaleString()} ${kept === 1 ? 'game' : 'games'} already in your library stay.`
      : 'Canceled. Nothing was kept.'
  }

  /** Transfers removed while running: cleaned up once they stop. */
  private removed = new Set<string>()

  /** Which of these replay ids / file hashes the Replay Library has on disk. */
  private async owned(ids: string[], hashes: string[] = []) {
    try {
      const { have, haveHashes } = await this.deps
        .getLibrary()
        .lookup(ids, hashes.filter(Boolean))
      return new Set([...Object.keys(have), ...Object.keys(haveHashes)])
    } catch {
      return new Set<string>()
    }
  }

  private save() {
    if (this.loadError) throw new Error(this.loadError)
    writeSavedTransfers(this.statePath, this.jobs)
  }

  private broadcast(force = false) {
    if (!force && Date.now() - this.lastBroadcast < 200) return
    this.lastBroadcast = Date.now()
    if (!this._window.isDestroyed())
      this._window.webContents.send('databaseTransfers', this.list())
  }

  private update(
    job: SavedTransfer,
    patch: Partial<SavedTransfer>,
    persist = true,
  ) {
    // When it finished, for the History list.
    if (
      (patch.stage === 'completed' || patch.stage === 'canceled') &&
      job.stage !== patch.stage
    )
      patch = { ...patch, finishedAt: Date.now() }
    logStage(this.deps, job, patch)
    Object.assign(job, patch)
    if (persist) this.save()
    this.broadcast(persist)
  }

  async handle(event: IpcMainEvent, data: unknown) {
    const { requestId, payload: raw } = unpackRequest<unknown>(data)
    try {
      const payload: DatabaseRequest =
        parseClipRequest(raw) ?? parseDatabaseRequest(raw)
      if (payload.action === 'search') {
        const page = Math.max(1, Math.min(10000, payload.page))
        const search = await this.client.json(
          '/api/getList',
          databaseSearchBody(payload.filters, page, 25),
        )
        const replays = (search as { results?: DatabaseReplay[] })?.results
        if (Array.isArray(replays)) {
          const owned = await this.owned(
            replays.map((r) => r._id),
            replays.map((r) => r.fileHash ?? ''),
          )
          for (const r of replays)
            if (owned.has(r._id) || (r.fileHash && owned.has(r.fileHash)))
              r.inLibrary = true
        }
        reply(event, 'databaseRequest', requestId, { search })
        return
      }
      if (payload.action === 'estimate') {
        // Every game Find replays offers is stored: its download is exactly what
        // the locations count says (games and bytes on storage). One query, no
        // queue forecast (no bundle is ever packed). An older website without the
        // count: the database's estimate of the same stored-only selection.
        const body = databaseExportFilter(payload.filters)
        const counts = parseDirectCounts(
          await this.client
            .json('/api/clipper?action=direct-locations', {
              ...body,
              count: true,
            })
            .catch((error) => {
              if (
                isMaintenanceError(error) ||
                (error instanceof DatabaseRequestError && error.status === 429)
              )
                throw error
              return null
            }),
        )
        const estimate = counts
          ? estimateFromStored(counts)
          : parseDatabaseEstimate(
              await this.client.json<Record<string, unknown>>(
                '/api/download?action=estimate',
                body,
              ),
            )
        reply(event, 'databaseRequest', requestId, { estimate })
        return
      }
      if (payload.action === 'fullDbInfo') {
        let fullDb = null
        try {
          fullDb = parseFullDbInfo(
            await this.client.json('/api/download?action=bundles&limit=50'),
          )
        } catch {
          fullDb = null
        }
        reply(event, 'databaseRequest', requestId, { fullDb })
        return
      }
      if (payload.action === 'status') {
        // The site's live status: admin notice, database up/down, queue length.
        let status = null
        try {
          status = parseSiteStatus(await this.client.json('/api/status'))
        } catch {
          status = null
        }
        // A website that has a minimum Clipper version this build is below:
        // say so in the status notice (the panel already shows it).
        const minimum = status?.clipper?.minimum
        if (status && minimum) {
          const cmp = compareVersions(app.getVersion(), minimum)
          if (cmp !== null && cmp < 0)
            status = {
              ...status,
              notice: {
                text:
                  status.clipper?.message ||
                  `This version of Lunar Clipper (${app.getVersion()}) is too old for the Lunar Database; update to ${minimum} or newer (Help > Check for updates).`,
                level: 'warning',
              },
            }
        }
        reply(event, 'databaseRequest', requestId, { status })
        return
      }
      if (payload.action === 'autocomplete') {
        // The website's search box: players (tag, code, other names) and
        // tournaments, from the same endpoints. An empty query lists the top ones.
        const q = encodeURIComponent(payload.q)
        const [players, tournaments] = await Promise.all([
          this.client
            .json(
              `/api/playerAutocomplete?q=${q}${
                payload.characters?.length
                  ? `&characters=${payload.characters.join(',')}`
                  : ''
              }`,
            )
            .then(parsePlayerSuggestions)
            .catch(() => []),
          payload.tournaments
            ? this.client
                .json(`/api/tournaments?q=${q}`)
                .then(parseTournamentSuggestions)
                .catch(() => [])
            : [],
        ])
        reply(event, 'databaseRequest', requestId, { players, tournaments })
        return
      }
      if (payload.action === 'clipSearch') {
        const found = await this.client.json<Partial<ClipSearchReply>>(
          '/api/clips',
          findClipsBody(payload.search, payload.page, payload.limit),
        )
        const clips: ClipSearchReply = {
          results: Array.isArray(found?.results) ? found!.results : [],
          total: typeof found?.total === 'number' ? found.total : null,
          capped: found?.capped === true,
          games:
            found?.games && typeof found.games.count === 'number'
              ? found.games
              : null,
        }
        const owned = await this.owned(clips.results.map((c) => c.replayId))
        for (const c of clips.results)
          if (owned.has(c.replayId)) c.inLibrary = true
        reply(event, 'databaseRequest', requestId, { clips })
        return
      }
      if (payload.action === 'replayInfo') {
        reply(event, 'databaseRequest', requestId, {
          replayInfo: await replayInfo(
            this.ctx,
            this.replayInfoCache,
            payload.replayId,
            payload.path,
          ),
        })
        return
      }
      if (payload.action === 'library') {
        const library = this.deps.getLibrary()
        const counts = (await library.summary?.()) ?? {
          games: 0,
          fromDatabase: 0,
        }
        reply(event, 'databaseRequest', requestId, {
          library: { folder: library.folder, ...counts },
        })
        return
      }
      if (payload.action === 'openLibrary') {
        const { folder } = this.deps.getLibrary()
        fs.mkdirSync(folder, { recursive: true })
        const error = await shell.openPath(folder)
        if (error) throw new Error(error)
        reply(event, 'databaseRequest', requestId, {})
        return
      }
      if (this.loadError) throw new Error(this.loadError)
      if (payload.action === 'clearFinished') {
        this.jobs = this.jobs.filter(
          (j) => j.stage !== 'completed' && j.stage !== 'canceled',
        )
        this.save()
        this.broadcast(true)
      } else if (payload.action === 'downloadFullDb') {
        await queueFullDb(this.ctx)
      } else if (payload.action === 'unpackFile') {
        await unpackFile(this.ctx, payload.id)
      } else if (payload.action === 'addClips') {
        await addClips(this.ctx, payload.clips)
      } else if (payload.action === 'addReplays') {
        await addReplays(this.ctx, payload.replayIds)
      } else if (
        payload.action === 'start' &&
        validateDatabaseFilters(payload.filters).maxFiles <=
          (this.deps.directMaxGames ?? ONE_BY_ONE_MAX_GAMES)
      ) {
        // A small batch: take the first stored games of the search and fetch
        // them one by one from storage (through the website).
        const search = (await this.client.json(
          '/api/getList',
          databaseSearchBody(payload.filters, 1, payload.filters.maxFiles),
        )) as { results?: DatabaseReplay[] }
        const ids = Array.isArray(search?.results)
          ? search.results.map((r) => r._id).filter(Boolean)
          : []
        if (!ids.length) throw new Error('No games matched these filters.')
        await addReplays(this.ctx, ids.slice(0, payload.filters.maxFiles))
      } else if (payload.action === 'start' || payload.action === 'extract') {
        let sources: string[] | undefined
        let filters: DatabaseFilters | undefined
        if (payload.action === 'start')
          filters = validateDatabaseFilters(payload.filters)
        else {
          const selected = await dialog.showOpenDialog(this._window, {
            title: 'Extract replay files',
            properties:
              payload.sourceKind === 'folder'
                ? ['openDirectory']
                : ['openFile', 'multiSelections'],
            filters: [
              { name: 'Replay archives', extensions: ['zip', 'slpz', 'slp'] },
            ],
          })
          if (selected.canceled) {
            reply(event, 'databaseRequest', requestId, {
              transfers: this.list(),
            })
            return
          }
          sources = selected.filePaths
        }
        await queueJob(
          this.ctx,
          payload.action === 'start'
            ? { kind: 'database', filters: filters! }
            : {
                kind: 'extract',
                sources: sources!,
                outputDir: payload.outputDir,
                importAfter: payload.importAfter,
              },
        )
      } else if (payload.action !== 'list') {
        const job = this.jobs.find((j) => j.id === payload.id)
        if (!job) throw new Error('Download not found.')
        if (payload.action === 'addToProject') {
          // A finished transfer's replays into the project open now (they're
          // on disk already; nothing is downloaded again).
          if (job.stage !== 'completed' || !job.preparedPath)
            throw new Error('This download has nothing to add yet.')
          if (!this.deps.getArchive()) await this.deps.ensureProject()
          const archive = this.deps.getArchive()
          if (!archive) throw new Error('Open or create a project first.')
          this.update(job, {
            stage: 'queued',
            projectPath: archive.path,
            projectName: archive.name,
            error: undefined,
            detail: `Adding to “${archive.name}”`,
          })
        } else if (payload.action === 'remove') {
          // Drops it from the list. Replays it already brought in stay in the
          // library; an unfinished download's partial file is deleted.
          this.jobs = this.jobs.filter((j) => j !== job)
          if (this.active?.id === job.id) {
            this.active.abort.abort()
            this.removed.add(job.id)
          } else if (job.stage !== 'completed') discardPartial(job)
          this.save()
          this.broadcast(true)
        } else if (payload.action === 'open') {
          // The first of these that exists: a library batch's replays are spread
          // across the library folder (and games fetched one by one never get a
          // folder of their own), a bundle unpacks into its outputDir, which only
          // exists once it starts. Works the same running, paused or done.
          const library = this.deps.getLibrary().folder
          const libraryBatch =
            job.kind === 'database' &&
            (job.preparedPath?.endsWith('.json') ||
              !!job.gamesFile ||
              !!job.clipsFile ||
              !!job.replayIds?.length)
          const candidates =
            job.kind === 'database'
              ? libraryBatch
                ? [library]
                : [job.outputDir, library]
              : [job.outputDir, path.dirname(job.outputDir)]
          const target = candidates.find((dir) => dir && fs.existsSync(dir))
          if (!target) throw new Error('That folder doesn’t exist yet.')
          const error = await shell.openPath(target)
          if (error) throw new Error(error)
        } else if (payload.action === 'cancel') {
          // Stop for good and delete the partial download; the entry stays
          // (✕ removes it). Games already in the library stay.
          if (job.stage !== 'completed' && job.stage !== 'canceled') {
            if (this.active?.id === job.id) {
              this.canceling.add(job.id)
              this.active.abort.abort()
              this.update(job, { detail: 'Canceling…' })
            } else {
              discardPartial(job)
              this.savedCache.delete(job.id)
              this.update(job, {
                stage: 'canceled',
                error: undefined,
                waitingForDatabase: undefined,
                detail: await this.canceledDetail(job),
              })
            }
          }
        } else if (payload.action === 'pause') {
          if (job.stage !== 'completed') {
            if (this.active?.id === job.id) this.active.abort.abort()
            this.update(job, {
              stage: 'paused',
              waitingForDatabase: undefined,
              detail: 'Paused. Resume when ready.',
            })
          }
        } else if (payload.action === 'resume') {
          if (this.active?.id === job.id)
            throw new Error(
              'The download is still stopping. Try again in a moment.',
            )
          if (job.stage !== 'completed') {
            if (job.exportGone) {
              // Explicit user action: start a new server export with the same
              // filters. The old partial download belongs to the old export.
              for (const name of [
                'download.zip.part',
                'download.zip.part.json',
              ])
                fs.rmSync(path.join(job.outputDir, name), { force: true })
              this.update(job, {
                stage: 'queued',
                error: undefined,
                exportGone: undefined,
                remoteId: undefined,
                token: undefined,
                detail: 'Starting a new export',
              })
            } else
              this.update(job, {
                stage: 'queued',
                error: undefined,
                waitingForDatabase: undefined,
                detail: 'Waiting to resume',
              })
          }
        } else throw new Error('Unknown transfer action.')
      }
      reply(event, 'databaseRequest', requestId, { transfers: this.list() })
      this.broadcast(true)
      this.pump()
    } catch (error) {
      reply(event, 'databaseRequest', requestId, {
        error:
          error instanceof Error ? error.message : 'Database request failed.',
        ...(error instanceof DatabaseRequestError && error.status === 429
          ? { retryAfter: error.retryAfterSeconds ?? 5 }
          : {}),
        // Down for maintenance: the panel shows the message, not an error.
        ...(isMaintenanceError(error)
          ? {
              maintenance: {
                message: (error as Error).message,
                since: (error as DatabaseRequestError).since ?? null,
              },
            }
          : {}),
      })
    }
  }

  /**
   * Download these Lunar Database replays into the library, without importing
   * them anywhere (e.g. "Download again" for replays deleted from disk: they
   * return to their library paths, so projects find them again).
   */
  downloadReplays(replayIds: string[], title: string): Transfer {
    if (this.loadError) throw new Error(this.loadError)
    const ids = [...new Set(replayIds)].filter((id) =>
      /^[a-f0-9]{24}$/.test(id),
    )
    if (ids.length === 0) throw new Error('Nothing to download.')
    if (ids.length > 100_000)
      throw new Error('Too many replays for one download.')
    const id = randomUUID()
    const outputDir = path.join(
      this.deps.getLibrary().folder,
      'Downloads',
      `Lunar-${new Date().toISOString().slice(0, 10)}-${id.slice(0, 8)}`,
    )
    fs.mkdirSync(outputDir, { recursive: true })
    const job: SavedTransfer = {
      id,
      kind: 'database',
      title,
      createdAt: Date.now(),
      stage: 'queued',
      detail: 'Waiting to start',
      outputDir,
      current: 0,
      total: null,
      replayIds: ids,
    }
    this.jobs.unshift(job)
    this.save()
    this.broadcast(true)
    this.pump()
    return this.list()[0]
  }

  /**
   * File › Extract Replays…: unpack ZIP / SLPZ archives (or a folder of them)
   * into playable .slp files, optionally adding them to the project. It used
   * to be a tab of the Lunar Database panel; it's about local files.
   */
  async extractFromMenu(sourceKind: 'files' | 'folder') {
    if (this.loadError) throw new Error(this.loadError)
    const selected = await dialog.showOpenDialog(this._window, {
      title: 'Extract replays',
      properties:
        sourceKind === 'folder'
          ? ['openDirectory']
          : ['openFile', 'multiSelections'],
      filters: [
        { name: 'Replay archives', extensions: ['zip', 'slpz', 'slp'] },
      ],
    })
    if (selected.canceled || selected.filePaths.length === 0) return false
    const archive = this.deps.getArchive()
    const destination = defaultReplaysFolder()
    const { response } = await askDialog(this._window, {
      type: 'question',
      title: 'Extract replays',
      message:
        sourceKind === 'folder'
          ? 'Extract the replays in this folder?'
          : `Extract ${selected.filePaths.length.toLocaleString()} ${selected.filePaths.length === 1 ? 'file' : 'files'}?`,
      detail: `They're unpacked into ${destination}; your originals are kept.`,
      buttons: [
        shownProjectName(archive?.name)
          ? `Extract and add to “${archive?.name}”`
          : 'Extract and add',
        'Extract only',
        'Cancel',
      ],
      defaultId: 0,
      cancelId: 2,
    })
    if (response === 2) return false
    await queueJob(this.ctx, {
      kind: 'extract',
      sources: selected.filePaths,
      importAfter: response === 0,
    })
    this.broadcast(true)
    this.pump()
    return true
  }

  /** Whether a transfer is using the library right now (not finished/paused). */
  get busy(): boolean {
    return this.jobs.some((j) =>
      [
        'queued',
        'preparing',
        'downloading',
        'extracting',
        'importing',
      ].includes(j.stage),
    )
  }

  /** The library folder moved: keep each transfer's folder and every file it
   *  keeps there (file lists, clips, direct results) pointing at it. They are all
   *  checked to lie inside outputDir when the history is loaded, so moving only
   *  some of them would make the next start refuse the history (launch review DL-2). */
  relocate(oldFolder: string, newFolder: string) {
    const changed = relocateJobs(this.jobs, oldFolder, newFolder)
    if (changed) {
      try {
        this.save()
      } catch (error) {
        logMain('transfers: could not save after the library moved', error)
      }
      this.broadcast(true)
    }
  }

  private pump() {
    if (this.closed || this.active) return
    const job = [...this.jobs].reverse().find((j) => j.stage === 'queued')
    if (!job) return
    const abort = new AbortController()
    this.active = { id: job.id, abort }
    // A download or unpack takes hours: the computer must not sleep under it.
    const letSleep = holdAwake('transfer')
    runJob(this.ctx, job, abort.signal)
      .catch(async (raw) => {
        const error = classifyRemoteError(raw)
        try {
          if (abort.signal.aborted && this.canceling.has(job.id)) {
            discardPartial(job)
            this.savedCache.delete(job.id)
            const detail = await this.canceledDetail(job)
            this.update(job, {
              stage: 'canceled',
              error: undefined,
              detail,
            })
          } else if (abort.signal.aborted)
            this.update(job, {
              stage: 'paused',
              error: undefined,
              detail: 'Paused. Resume to continue.',
            })
          else if (error instanceof MaintenanceError)
            this.pauseForMaintenance(job, error.message)
          else if (error instanceof RetryLaterError)
            this.update(job, {
              stage: 'paused',
              error: undefined,
              detail: `${error.message} Resume to try again.`,
            })
          // (A stored-only download has no export: its 404s are plain failures.)
          else if (error instanceof ExportGoneError && !job.storedOnly)
            this.update(job, {
              stage: 'failed',
              exportGone: true,
              error: `${error.message} Resume to start a new export with the same filters.`,
              detail: 'Export no longer available.',
            })
          else
            this.update(job, {
              stage: 'failed',
              error: error.message,
              detail: 'Transfer needs attention.',
            })
        } catch {
          this.broadcast(true)
        }
      })
      .finally(() => {
        letSleep()
        this.active = undefined
        this.canceling.delete(job.id)
        if (this.removed.delete(job.id)) {
          if (job.stage !== 'completed') discardPartial(job)
          this.save()
          this.broadcast(true)
        }
        if (job.stage === 'completed') this.deps.onCompleted?.(job)
        this.pump()
      })
  }

  /** Dev "reset all": stop any transfer and forget the history. */
  reset() {
    this.active?.abort.abort()
    this.jobs = []
    fs.rmSync(this.statePath, { force: true })
    this.broadcast(true)
  }

  cleanup() {
    this.closed = true
    clearTimeout(this.maintenanceTimer)
    this.active?.abort.abort()
  }
}
