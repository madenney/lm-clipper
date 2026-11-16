import { app, ipcMain, IpcMainEvent, BrowserWindow } from 'electron'
import { Worker } from 'worker_threads'
import { randomUUID } from 'crypto'
import os from 'os'
import path from 'path'
import fs, { promises as fsPromises } from 'fs'
import {
  DEFAULT_PROJECT_NAME,
  shownProjectName,
} from '../constants/defaultProject'
import { dialogHub, askDialog } from './askRenderer'

import { getWorkerExecArgv } from '../lib'

import { ensureProjectExt, projectDisplayName } from './projectFile'
import { detectPlaybackDolphin, detectMeleeIso } from './slippiDetect'
import {
  detectHardware,
  detectHardwareSync,
  freeDiskGB,
  hardwareProfileOf,
  type HardwareInfo,
} from './hardware'
import { config as defaultConfig } from '../constants/defaults'

import { ArchiveInterface, ConfigInterface } from '../constants/types'
import Archive from '../models/Archive'

import { cleanupStaleTempDirs, scratchRootFor } from './diskSpace'
import { setFFMPEGPathOverride } from './slpToVideo'

import {
  getMetaData,
  createDBAsync,
  closeDbAsync,
  libraryCall,
} from './dbAsync'

import { setClientIdentity } from './clientIdentity'
import { defaultLibraryFolder } from './dataLocations'
import { approveOnce } from './customCodeApproval'
import { logMain } from './logger'

import { initTelemetry, reportStartupTelemetry } from './telemetry'
import { migrateConfigTypes } from './configStore'
import { startOwnerTools } from '../owner/main'

import { RequestEnvelope, unpackRequest } from './ipcUtils'

import type { FileSeen, GameHeader, LibraryEntry } from './replayLibrary'
import type { MissingReport } from './missingReplays'

import { LunarClip } from '../constants/clipSearch'

import ConsoleManager from './managers/ConsoleManager'
import ImportManager from './managers/ImportManager'
import FilterExecutor from './managers/FilterExecutor'
import VideoManager from './managers/VideoManager'
import ClipManager from './managers/ClipManager'
import CodeEditorManager from './managers/CodeEditorManager'
import TransferManager from './managers/TransferManager'
import { getSlpzPath } from './util'

import { pruneSlpCache } from './slpCache'

import OverviewService from './controller/overview'
import type { ControllerCore } from './controller/context'
import { getDefaultProjectDir, autoFilterThreads } from './controller/helpers'
import {
  getConfig,
  setDefaultOutputPath,
  updateConfig,
  resetConfig,
  resetApp,
  hasDevBackup,
  restoreDevBackup,
} from './controller/ipcConfig'
import {
  getArchive,
  createNewArchive,
  getDirectory,
  openExistingArchive,
  closeArchive,
  openMyReplays,
  newProject,
  saveAsArchive,
  getRecentProjects,
  openRecentProject,
} from './controller/projects'
import {
  addFilter,
  applyStarterChain,
  removeFilter,
  saveCustomFilter,
  deleteCustomFilter,
  reorderFilter,
  updateFilter,
} from './controller/filters'
import {
  getResults,
  getSelectionDuration,
  getTableDuration,
  getFilterCount,
  getNames,
  getConnectCodes,
} from './controller/results'
import { compactProject } from './controller/compaction'
import {
  moveReplayLibrary,
  addLunarClips,
  detectorCache,
  extractReplays,
} from './controller/libraryTools'
import {
  startMissingCheck,
  publishMissing,
  getMissingReplays,
  missingReplaysAction,
} from './controller/missingReplays'
import {
  createCpuScan,
  createLastFrameScan,
  getLastFrameScanStatus,
  lastFrameScanAction,
  getCpuScanStatus,
  cpuScanAction,
} from './controller/scans'
import {
  getPath,
  logPerfEvents,
  debugLog,
  logRendererError,
  readReplayFile,
  getClipTrack,
  openFolder,
  openDolphinFolder,
  openLogsFolder,
  getLogsPath,
  exportLogs,
  getAppVersion,
  openExternal,
} from './controller/ipcMisc'
import {
  overlayFontsImport,
  overlayFontsList,
  overlayFontsRemove,
  overlayPreview,
} from './controller/overlayFonts'

export default class Controller implements ControllerCore {
  /** Overview reads in progress, saving to the disk cache as they go (controller/overview.ts). */
  private overview = new OverviewService(this)

  mainWindow: BrowserWindow
  configDir: string
  configPath: string
  // Pre-preview config saved by the dev "reset to new user" (see resetApp).
  devBackupPath: string
  // Serializes config writes so the ~20 fire-and-forget saveConfig() callers
  // can't interleave and corrupt the JSON file.
  configWriteChain: Promise<void> = Promise.resolve()
  archive: ArchiveInterface | null
  private archiveVersion = 0
  config: ConfigInterface
  nameCountWorker: Worker | null
  countWorkerExecArgv?: string[]

  // Fired once, the first time the renderer requests the archive (i.e. once it
  // has mounted and registered its IPC listeners). main.ts uses this to safely
  // flush an OS-initiated "open this .lunar file" without racing the renderer.
  onRendererReady: (() => void) | null = null

  rendererReadyFired = false

  // First run waits (briefly) for the graphics check before handing the
  // renderer its config, so the recording settings it shows are the picked ones.
  hardwareReady: Promise<void> = Promise.resolve()

  // Managers
  consoleManager: ConsoleManager
  importManager: ImportManager
  filterExecutor: FilterExecutor
  videoManager: VideoManager
  clipManager: ClipManager
  codeEditorManager: CodeEditorManager
  transferManager: TransferManager

  constructor(mainWindow: BrowserWindow) {
    this.mainWindow = mainWindow
    // In-app dialogs (askRenderer.ts): shown once the page has mounted.
    ipcMain.on('dialogReady', () => dialogHub.setReady(true))
    ipcMain.on('dialogReply', (_event: IpcMainEvent, data?: unknown) => {
      const r = (data ?? {}) as {
        id?: string
        response?: number
        checkboxChecked?: boolean
      }
      if (typeof r.id === 'string')
        dialogHub.reply(r.id, Number(r.response), !!r.checkboxChecked)
    })
    mainWindow.webContents.on('did-start-loading', () =>
      dialogHub.setReady(false),
    )
    mainWindow.on('closed', () => dialogHub.windowClosed(mainWindow))
    this.configDir = path.resolve(app.getPath('appData'), 'lm-clipper')
    if (!fs.existsSync(this.configDir)) fs.mkdirSync(this.configDir)
    this.configPath = path.resolve(this.configDir, 'lm-clipper.json')
    this.devBackupPath = `${this.configPath}.dev-backup`
    const isFirstRun = !fs.existsSync(this.configPath)
    if (isFirstRun)
      fs.writeFileSync(this.configPath, JSON.stringify(defaultConfig, null, 2))

    let loadedConfig: any
    try {
      loadedConfig = JSON.parse(fs.readFileSync(this.configPath).toString())
    } catch (err) {
      // Corrupt config: back it up instead of silently reverting to defaults,
      // so the user's recentProjects/paths aren't lost and can be recovered.
      logMain('config-corrupt', (err as { message?: string })?.message ?? err)
      try {
        fs.renameSync(this.configPath, `${this.configPath}.corrupt`)
      } catch (_) {
        // best-effort backup
      }
      loadedConfig = {}
    }
    this.config = { ...defaultConfig, ...loadedConfig }
    // Fast Draft became Recording Format: someone who had it on keeps drafts.
    if (
      (loadedConfig as { fastDraft?: boolean }).fastDraft === true &&
      !('recordingFormat' in loadedConfig)
    )
      this.config.recordingFormat = 'draft'
    if (isFirstRun) {
      // A fresh install has nothing to catch up on: "What's new" starts at this version.
      this.config.lastSeenVersion = app.getVersion()
      // First run: pick a sensible filter-thread count from the user's CPU.
      // (Video/Dolphin parallelism stays conservative; set separately.)
      this.config.numFilterThreads = autoFilterThreads()
      // Recording settings for this computer from its threads and memory now;
      // the graphics check (async) refines them just below.
      this.applyHardwarePicks(detectHardwareSync())
      // And auto-detect their existing Slippi setup (Playback Dolphin + the ISO
      // path they already configured in the Slippi Launcher) so they never have
      // to set it up — if found, the setup wizard won't even appear.
      this.config.dolphinPath ||= detectPlaybackDolphin() || ''
      this.config.ssbmIsoPath ||= detectMeleeIso() || ''
    }
    // Always merge built-in templates from defaults + keep user templates
    const userTemplates = (this.config.savedCustomFilters || []).filter(
      (t: any) => !t.builtIn,
    )
    this.config.savedCustomFilters = [
      ...defaultConfig.savedCustomFilters,
      ...userTemplates,
    ]
    this.ensureDefaultOutputPath()
    if (this.config.lastArchivePath === '') {
      this.config.lastArchivePath = null
    }
    migrateConfigTypes(this.config)
    // Anonymous, random per-install id (not a machine fingerprint). Generated
    // once and persisted via the saveConfig() below; also set for existing
    // users upgrading from a build that predates telemetry.
    if (!this.config.installId) {
      this.config.installId = randomUUID()
    }
    // The one-time `install` ping stays pending on disk until the server
    // acknowledges it (see reportStartupTelemetry), so a first launch with no
    // network or a quit before the notice does not lose it for good.
    if (isFirstRun) this.config.installPingPending = true
    // Every call to lunarmelee.com carries the app version (never the install id).
    setClientIdentity({ version: app.getVersion() })
    this.saveConfig()
    if (this.config.ffmpegPath) {
      setFFMPEGPathOverride(this.config.ffmpegPath)
    }
    // First run: pick recording settings with the graphics known too. Later
    // runs that predate hardwareProfile just record it (for Settings' warnings)
    // and keep the user's settings.
    if (isFirstRun || !this.config.hardwareProfile) {
      const apply = isFirstRun
      this.hardwareReady = detectHardware(this.config.outputPath)
        .then((hw) => {
          if (apply) this.applyHardwarePicks(hw)
          else this.config.hardwareProfile = hardwareProfileOf(hw)
          logMain('hardware', this.config.hardwareProfile)
          this.saveConfig()
        })
        .catch((err) => logMain('hardware detection failed', err))
    }
    // Dolphin temp folders a crashed or killed recording left behind.
    cleanupStaleTempDirs(
      this.config.scratchPath
        ? { scratchRoots: [scratchRootFor(this.config)] }
        : {},
    ).catch((err) => logMain('cleanupStaleTempDirs failed', err))
    this.archive = null
    this.nameCountWorker = null
    this.countWorkerExecArgv = getWorkerExecArgv()

    // Initialize managers
    this.consoleManager = new ConsoleManager(mainWindow, {
      getActiveFilter: () => this.filterExecutor.activeFilter,
      getActiveVideoJob: () => this.videoManager.activeVideoJob,
      getActiveImportArchive: () => this.importManager.activeImportArchive,
      getImportStatus: () => this.importManager.importStatus,
    })

    const setArchiveWithVersion = (a: ArchiveInterface | null) => {
      this.setArchiveInternal(a)
    }

    this.importManager = new ImportManager(mainWindow, {
      getLibrary: () => this.library(),
      getConfig: () => this.config,
      getConfigPath: () => this.configPath,
      saveConfig: () => this.saveConfig(),
      getArchive: () => this.archive,
      setArchive: setArchiveWithVersion,
      getArchiveVersion: () => this.archiveVersion,
      autoCreateUntitledProject: () => this.autoCreateUntitledProject(),
      consoleManager: this.consoleManager,
    })

    // Decoded .slpz copies for Dolphin from earlier sessions (main/slpCache.ts).
    pruneSlpCache().catch(() => {})

    this.transferManager = new TransferManager(mainWindow, {
      configDir: this.configDir,
      getArchive: () => this.archive,
      ensureProject: () => this.autoCreateUntitledProject(),
      getSlpzBinary: () => this.config.slpzPath || getSlpzPath(),
      getLibrary: () => this.library(),
      // Downloaded replays may be ones a project was missing.
      onCompleted: () => startMissingCheck(this),
      addClips: (projectPath, clips, pathByReplayId) =>
        this.addLunarClips(projectPath, clips, pathByReplayId),
      importer: this.importManager,
      console: this.consoleManager,
    })

    this.filterExecutor = new FilterExecutor(mainWindow, {
      // A finished run's table is ready: cache its overview for the tray.
      onFilterDone: (filterId) => {
        this.overview.warmOverview(filterId).catch(() => {})
      },
      getLibraryFolder: () => this.library().folder,
      getArchive: () => this.archive,
      setArchive: setArchiveWithVersion,
      getConfig: () => this.config,
      consoleManager: this.consoleManager,
    })

    this.videoManager = new VideoManager(mainWindow, {
      getArchive: () => this.archive,
      setArchive: setArchiveWithVersion,
      getConfig: () => this.config,
      consoleManager: this.consoleManager,
    })

    this.clipManager = new ClipManager(mainWindow, {
      getArchive: () => this.archive,
      setArchive: setArchiveWithVersion,
      // Deleting replays from the Replays tray forgets them here too.
      getLibraryFolder: () => this.library().folder,
      getMyReplaysPath: () => this.defaultWorkspacePath(),
    })

    this.codeEditorManager = new CodeEditorManager(mainWindow, {
      getArchive: () => this.archive,
      getConfig: () => this.config,
      saveConfig: () => {
        this.saveConfig()
      },
    })

    // Anonymous usage telemetry (opt-out: Settings → Send Anonymous Usage Data).
    initTelemetry({
      getConfig: () => this.config,
      saveConfig: () => {
        this.saveConfig()
      },
    })
    reportStartupTelemetry(app.getVersion())
  }

  saveConfig(): Promise<void> {
    // Queue behind any in-flight write (serialize), and write atomically via a
    // temp file + rename so a crash mid-write can never leave a truncated/
    // corrupt config. Each queued write serializes the then-current config.
    this.configWriteChain = this.configWriteChain
      .catch(() => {}) // a prior failure must not break the chain
      .then(async () => {
        const data = JSON.stringify(this.config, null, 2)
        const tmp = `${this.configPath}.tmp`
        // 0600: the config can hold private keys.
        await fsPromises.writeFile(tmp, data, { mode: 0o600 })
        await fsPromises.rename(tmp, this.configPath)
      })
      .catch((err: { message?: string }) => {
        logMain('config-save-failed', err?.message ?? err)
      })
    return this.configWriteChain
  }

  // Come up on a just-replaced config as if the app had started with it. Waits
  // for the config write first. Packaged: a true process restart. Dev
  // (electronmon): a process relaunch doesn't reliably come back, so reopen the
  // config's last project (none after a reset) and reload the window; the
  // renderer re-fetches config and archive.
  async restartIntoConfig() {
    await this.configWriteChain
    if (app.isPackaged) {
      app.relaunch()
      app.exit(0)
      return
    }
    await this.initArchive()
    this.mainWindow.webContents.reload()
  }

  /** The replay library (main/replayLibrary.ts), on the DB worker thread. */
  library() {
    const folder = this.config.replayLibraryPath || defaultLibraryFolder()
    return {
      folder,
      // New downloads are stored as .slpz (Settings > Paths; lib/slpz.ts).
      compress: this.config.keepDownloadsCompressed !== false,
      lookup: (replayIds: string[], fileHashes: string[]) =>
        libraryCall('libraryLookup', folder, replayIds, fileHashes),
      register: (entries: LibraryEntry[]) =>
        libraryCall('libraryRegister', folder, entries),
      headers: (files: FileSeen[]) =>
        libraryCall('libraryHeaders', folder, files),
      record: (files: (FileSeen & { header: GameHeader })[]) =>
        libraryCall('libraryRecordHeaders', folder, files),
      summary: () => libraryCall('librarySummary', folder),
    }
  }

  /** Move the replay library to a new folder (controller/libraryTools.ts). */
  async moveReplayLibrary(event: IpcMainEvent, data?: RequestEnvelope<string>) {
    return moveReplayLibrary(this, event, data)
  }

  /** Find clips › Add to project, last step (TransferManager; controller/libraryTools.ts). */
  async addLunarClips(
    projectPath: string,
    clips: LunarClip[],
    pathByReplayId: Record<string, string>,
  ): Promise<{ added: number; unavailable: number }> {
    return addLunarClips(this, projectPath, clips, pathByReplayId)
  }

  /** File › Extract Replays… (controller/libraryTools.ts). */
  async extractReplays(kind: 'files' | 'folder') {
    return extractReplays(this, kind)
  }

  /** Project file being compacted; it can't be opened until that finishes. */
  compactingPath: string | null = null

  setArchiveInternal(a: ArchiveInterface | null) {
    this.archive = a
    this.archiveVersion += 1
    this.updateWindowTitle()
  }

  // Reload the archive model from a project's DB and make it current. Returns
  // the metadata for callers that need it (e.g. to reply or read the name).
  async reloadArchiveFrom(archivePath: string) {
    if (this.compactingPath === archivePath)
      throw new Error(
        'This project is being compacted. Try again when it finishes.',
      )
    const metadata = await getMetaData(archivePath)
    // The path persisted inside a project's metadata goes stale the moment the
    // file is moved or renamed. Always trust the path we actually opened from,
    // otherwise Archive.path points at the old location and result-fetch workers
    // (getItems et al.) open — and silently recreate — an empty DB there.
    if (metadata) metadata.path = archivePath
    this.setArchiveInternal(new Archive(metadata))
    startMissingCheck(this)
    return metadata
  }

  // ── Replays missing from disk (docs/library-workspaces.md, Part D) ──

  missingReport: MissingReport | null = null

  missingWorker: Worker | null = null

  // The missing-replay check and its IPC handlers: controller/missingReplays.ts

  // ── CPU players in older games (lib/cpuPlayers.ts, CpuScanWorker.ts) ──

  cpuScan = createCpuScan(this)

  // ── Lengths of older anonymized games (lib/lastFrame.ts, LastFrameScanWorker.ts) ──

  lastFrameScan = createLastFrameScan(this)

  /**
   * The background checks over the open project's games: `cpu` for games
   * that don't have it (CpuScanWorker) and the length of anonymized games
   * imported before Clipper read it (LastFrameScanWorker). Low priority,
   * paused while an import or a filter runs, resume where they stopped next
   * time. Nothing to do is quick.
   */
  startCpuScan() {
    this.cpuScan.start(this.archive?.path)
    this.lastFrameScan.start(this.archive?.path)
  }

  /** Stop the checks before their project is closed, copied or switched;
   *  resolves once their connections to the project are gone. */
  stopCpuScan(): Promise<void> {
    return Promise.all([this.cpuScan.stop(), this.lastFrameScan.stop()]).then(
      () => {},
    )
  }

  updateWindowTitle() {
    if (this.mainWindow?.isDestroyed?.()) return
    const name = shownProjectName(this.archive?.name)
    this.mainWindow.setTitle(name ? `Lunar Clipper — ${name}` : 'Lunar Clipper')
  }

  cleanup() {
    this.transferManager.cleanup()
    // Stop console polling
    this.consoleManager.cleanup()

    // Kill active video/playback
    this.videoManager.cleanup()

    // Abort running filters
    this.filterExecutor.cleanup()

    // Abort running import
    this.importManager.cleanup()

    // Kill name count worker
    this.stopNameCountWorker()
    this.stopCpuScan()

    // Close code editor window and clean up its IPC listeners
    this.codeEditorManager.cleanup()
  }

  addToRecentProjects(name: string, projectPath: string) {
    if (!this.config.recentProjects) this.config.recentProjects = []
    this.config.recentProjects = this.config.recentProjects.filter(
      (p) => p.path !== projectPath,
    )
    this.config.recentProjects.unshift({
      name,
      path: projectPath,
      lastOpened: Date.now(),
    })
    if (this.config.recentProjects.length > 10) {
      this.config.recentProjects = this.config.recentProjects.slice(0, 10)
    }
    this.saveConfig()
    this.onRecentsChanged?.()
  }

  /** The File > Open Recent menu is rebuilt when the list changes (main.ts). */
  onRecentsChanged: (() => void) | null = null

  removeFromRecentProjects(projectPath: string) {
    if (!this.config.recentProjects) return
    queueMicrotask(() => this.onRecentsChanged?.())
    this.config.recentProjects = this.config.recentProjects.filter(
      (p) => p.path !== projectPath,
    )
    this.saveConfig()
  }

  /** "New Project", "New Project 2", … : the first name not taken in `dir`. */
  getUntitledName(dir: string, base = 'Untitled'): string {
    let name = base
    let counter = 1
    while (fs.existsSync(ensureProjectExt(path.resolve(dir, name)))) {
      counter += 1
      name = `${base} ${counter}`
    }
    return name
  }

  /** The default workspace: quick imports land here when no project is open
   *  (docs/library-workspaces.md, Part B). Kept in app data, out of Documents;
   *  Save As… makes a named project file anywhere. */
  defaultWorkspacePath() {
    return path.join(app.getPath('userData'), 'Workspaces', 'My Replays.lunar')
  }

  /** Open "My Replays", creating it the first time. (Imports and downloads
   *  with no project open used to create a new Untitled N.lunar each time.) */
  async autoCreateUntitledProject() {
    const workspace = this.defaultWorkspacePath()
    if (!fs.existsSync(workspace)) {
      fs.mkdirSync(path.dirname(workspace), { recursive: true })
      return this.createNewArchiveInternal({
        name: DEFAULT_PROJECT_NAME,
        location: path.dirname(workspace),
      })
    }
    this.stopNameCountWorker()
    await this.stopCpuScan()
    await closeDbAsync()
    const metadata = await this.reloadArchiveFrom(workspace)
    this.config.lastArchivePath = workspace
    this.config.projectName = metadata.name
    this.saveConfig()
    this.addToRecentProjects(metadata.name, workspace)
    return metadata
  }

  async createNewArchiveInternal(payload: {
    name?: string
    location?: string
  }) {
    this.stopNameCountWorker()
    await this.stopCpuScan()
    await closeDbAsync()
    const newArchivePath = ensureProjectExt(
      path.resolve(
        payload.location || getDefaultProjectDir(),
        `${payload.name ? payload.name : 'lm-clipper-default-db'}`,
      ),
    )
    const displayName = projectDisplayName(newArchivePath)

    await createDBAsync(
      newArchivePath,
      displayName,
      this.config.includeDefaultFilters === true,
    )
    const metadata = await this.reloadArchiveFrom(newArchivePath)

    this.config.lastArchivePath = newArchivePath
    this.config.projectName = metadata.name
    this.saveConfig()
    this.addToRecentProjects(metadata.name, newArchivePath)

    return metadata
  }

  async initArchive() {
    if (!this.config.lastArchivePath) {
      this.setArchiveInternal(null)
      return
    }

    if (fs.existsSync(this.config.lastArchivePath)) {
      console.log('Loading from existing DB')
      try {
        await this.reloadArchiveFrom(this.config.lastArchivePath)
        this.updateWindowTitle()
        return
      } catch (e) {
        // The file is there but would not open this time (an antivirus or sync
        // client holding it, a lingering instance). Start on the start screen
        // but keep the path: the next start tries again instead of forgetting
        // the project (launch review REL-5).
        logMain('could not open the last project, keeping it for next time', e)
        this.setArchiveInternal(null)
        return
      }
    }

    // The file is gone: clear the stale path
    console.log('Last archive path not found, clearing')
    this.config.lastArchivePath = null
    this.saveConfig()
    this.setArchiveInternal(null)
  }

  /** Apply the recording settings picked for this hardware, and remember it. */
  applyHardwarePicks(hw: HardwareInfo) {
    const profile = hardwareProfileOf(hw)
    Object.assign(this.config, profile.picked)
    this.config.hardwareProfile = profile
  }

  /** Detect the hardware again and apply its picks (Reset, Settings button). */
  async pickSettingsForThisComputer() {
    try {
      this.applyHardwarePicks(await detectHardware(this.config.outputPath))
    } catch (err) {
      logMain('hardware detection failed', err)
      this.applyHardwarePicks(detectHardwareSync())
    }
    await this.refreshFreeDisk()
    logMain('hardware picks applied', this.config.hardwareProfile)
  }

  /** Free space at the output and temp folders, for Settings' disk note. */
  async refreshFreeDisk() {
    const hp = this.config.hardwareProfile
    if (!hp) return
    const scratch = this.config.scratchPath || os.tmpdir()
    const [out, tmp] = await Promise.all([
      freeDiskGB(this.config.outputPath),
      freeDiskGB(scratch),
    ])
    this.config.hardwareProfile = {
      ...hp,
      freeDiskGB: out,
      scratchFreeDiskGB: tmp,
    }
  }

  ensureDefaultOutputPath() {
    if (!this.config.outputPath) {
      this.config.outputPath = path.join(
        app.getPath('videos') || app.getPath('home'),
        'Lunar Clipper',
      )
      this.saveConfig()
    }
  }

  /** Close the open project: its work stops first, then its database. */
  /** Stop what is bound to the open project (before its database closes). */
  private async stopProjectWork() {
    this.stopNameCountWorker()
    this.stopCpuScan()
    // Abort any in-flight work bound to this project BEFORE closing its DB.
    // Otherwise a running import/filter worker keeps writing to a DB we're
    // closing (and the main getDb() would silently reopen the old path on its
    // next call), landing rows in a project the user already closed.
    this.videoManager.cleanup()
    this.filterExecutor.cleanup()
    this.importManager.cleanup()
    this.missingWorker?.terminate()
    publishMissing(this, null)
    await this.stopCpuScan()
  }

  /**
   * Before any other project is opened, created or saved as: if a filter, import
   * or recording is running for the open one, ask, and stop it. Without this a
   * .lunar double-click mid-run opened the new project under the old run, whose
   * results then landed in (or were marked done for) the wrong project
   * (launch review REL-2). False: the user chose to keep working.
   */
  async prepareProjectSwitch(): Promise<boolean> {
    if (!this.archive) return true
    const running: string[] = []
    if (this.filterExecutor.runningFilterIds.size > 0) running.push('a filter')
    if (this.importManager.importInProgress) running.push('an import')
    if (this.videoManager.activeVideoJob) running.push('a recording')
    if (running.length) {
      const { response } = await askDialog(this.mainWindow, {
        type: 'question',
        title: 'Switch project?',
        message: `${running.join(' and ')} ${running.length > 1 ? 'are' : 'is'} still running in this project.`,
        detail:
          'Opening another project stops it. Results already saved stay; a filter can be resumed.',
        buttons: ['Stop it and switch', 'Keep working here'],
        defaultId: 1,
        cancelId: 1,
      })
      if (response !== 0) return false
    }
    await this.stopProjectWork()
    return true
  }

  async closeCurrentProject() {
    await this.stopProjectWork()
    await closeDbAsync()
    this.setArchiveInternal(null)
    this.config.lastArchivePath = null
    this.saveConfig()
    this.importManager.setImportStatus({
      isImporting: false,
      current: 0,
      total: null,
      queueLength: 0,
    })
  }

  /** File > Compact Project… (controller/compaction.ts). */
  async compactProject() {
    return compactProject(this)
  }

  stopNameCountWorker() {
    if (!this.nameCountWorker) return
    const worker = this.nameCountWorker
    this.nameCountWorker = null
    worker.terminate().catch(() => {})
  }

  ensureNameCountWorker(): Worker {
    if (this.nameCountWorker) return this.nameCountWorker
    if (!this.archive) throw new Error('No archive')
    const worker = new Worker(
      new URL('./NameCountWorker.ts', import.meta.url),
      {
        workerData: { dbPath: this.archive.path },
        ...(this.countWorkerExecArgv
          ? { execArgv: this.countWorkerExecArgv }
          : {}),
      },
    )
    worker.on('error', (error) => {
      console.error('[NameCountWorker] error:', error)
      if (this.nameCountWorker === worker) {
        this.nameCountWorker = null
      }
    })
    worker.on('exit', () => {
      if (this.nameCountWorker === worker) {
        this.nameCountWorker = null
      }
    })
    this.nameCountWorker = worker
    return worker
  }

  // openCodeEditor, openCodeEditorForTemplate, _openCodeEditorWindow → CodeEditorManager

  initiateListeners() {
    ipcMain.on('getConfig', (event: IpcMainEvent, data: any) =>
      getConfig(this, event, data),
    )
    ipcMain.on('getMissingReplays', (event: IpcMainEvent, data: any) =>
      getMissingReplays(this, event, data),
    )
    ipcMain.on('getCpuScanStatus', (event: IpcMainEvent, data: any) =>
      getCpuScanStatus(this, event, data),
    )
    ipcMain.on('cpuScanAction', (event: IpcMainEvent, data: any) =>
      cpuScanAction(this, event, data),
    )
    ipcMain.on('getLastFrameScanStatus', (event: IpcMainEvent, data: any) =>
      getLastFrameScanStatus(this, event, data),
    )
    ipcMain.on('lastFrameScanAction', (event: IpcMainEvent, data: any) =>
      lastFrameScanAction(this, event, data),
    )
    ipcMain.on('moveReplayLibrary', (event: IpcMainEvent, data: any) =>
      moveReplayLibrary(this, event, data),
    )
    ipcMain.on('detectorCache', (event: IpcMainEvent, data: any) =>
      detectorCache(this, event, data),
    )
    ipcMain.on('extractReplays', (_event: IpcMainEvent, data?: unknown) => {
      const { payload } = unpackRequest<{ kind?: string }>(data)
      this.extractReplays(payload?.kind === 'folder' ? 'folder' : 'files')
    })
    ipcMain.on('missingReplaysAction', (event: IpcMainEvent, data: any) =>
      missingReplaysAction(this, event, data),
    )
    ipcMain.on(
      'databaseRequest',
      this.transferManager.handle.bind(this.transferManager),
    )
    startOwnerTools(ipcMain, {
      getConfig: () => this.config,
      saveConfig: () => {
        this.saveConfig()
      },
      getArchive: () => this.archive,
      openProject: (projectPath: string) => {
        if (!this.mainWindow.isDestroyed())
          this.mainWindow.webContents.send('openRecentFromMenu', projectPath)
      },
      releaseProject: async (projectPath: string) => {
        if (this.archive?.path !== projectPath) return
        await this.closeCurrentProject()
        if (!this.mainWindow.isDestroyed())
          this.mainWindow.webContents.send('archiveUpdated', null)
      },
    })
    ipcMain.on('updateConfig', (event: IpcMainEvent, data: any) =>
      updateConfig(this, event, data),
    )
    ipcMain.on('setDefaultOutputPath', (event: IpcMainEvent, data: any) =>
      setDefaultOutputPath(this, event, data),
    )
    ipcMain.on('getDirectory', (event: IpcMainEvent, data: any) =>
      getDirectory(this, event, data),
    )
    ipcMain.on('getArchive', (event: IpcMainEvent, data: any) =>
      getArchive(this, event, data),
    )
    ipcMain.on('getFilterCount', (event: IpcMainEvent, data: any) =>
      getFilterCount(this, event, data),
    )
    ipcMain.on(
      'getImportStatus',
      this.importManager.getImportStatusHandler.bind(this.importManager),
    )
    ipcMain.on('createNewArchive', (event: IpcMainEvent, data: any) =>
      createNewArchive(this, event, data),
    )
    ipcMain.on('openExistingArchive', (event: IpcMainEvent, data: any) =>
      openExistingArchive(this, event, data),
    )
    ipcMain.on('newProject', (event: IpcMainEvent, data: any) =>
      newProject(this, event, data),
    )
    ipcMain.on('openMyReplays', (event: IpcMainEvent, data: any) =>
      openMyReplays(this, event, data),
    )
    ipcMain.on('saveAsArchive', (event: IpcMainEvent, data: any) =>
      saveAsArchive(this, event, data),
    )
    ipcMain.on('getRecentProjects', (event: IpcMainEvent, data: any) =>
      getRecentProjects(this, event, data),
    )
    ipcMain.on('openRecentProject', (event: IpcMainEvent, data: any) =>
      openRecentProject(this, event, data),
    )
    ipcMain.on(
      'addFilesManual',
      this.importManager.addFilesManual.bind(this.importManager),
    )
    ipcMain.on(
      'addDroppedFiles',
      this.importManager.addDroppedFiles.bind(this.importManager),
    )
    ipcMain.on(
      'cancelImport',
      this.importManager.cancelImport.bind(this.importManager),
    )
    ipcMain.on(
      'stopImport',
      this.importManager.stopImport.bind(this.importManager),
    )
    ipcMain.on('closeArchive', (event: IpcMainEvent, data: any) =>
      closeArchive(this, event, data),
    )
    ipcMain.on('addFilter', (event: IpcMainEvent, data: any) =>
      addFilter(this, event, data),
    )
    ipcMain.on('applyStarterChain', (event: IpcMainEvent, data: any) =>
      applyStarterChain(this, event, data),
    )
    ipcMain.on('updateFilter', (event: IpcMainEvent, data: any) =>
      updateFilter(this, event, data),
    )
    ipcMain.on('reorderFilter', (event: IpcMainEvent, data: any) =>
      reorderFilter(this, event, data),
    )
    ipcMain.on('removeFilter', (event: IpcMainEvent, data: any) =>
      removeFilter(this, event, data),
    )
    ipcMain.on('saveCustomFilter', (event: IpcMainEvent, data: any) =>
      saveCustomFilter(this, event, data),
    )
    ipcMain.on('deleteCustomFilter', (event: IpcMainEvent, data: any) =>
      deleteCustomFilter(this, event, data),
    )
    ipcMain.on('getResults', (event: IpcMainEvent, data: any) =>
      getResults(this, event, data),
    )
    ipcMain.on('getSelectionDuration', (event: IpcMainEvent, data: any) =>
      getSelectionDuration(this, event, data),
    )
    ipcMain.on('getTableDuration', (event: IpcMainEvent, data: any) =>
      getTableDuration(this, event, data),
    )
    ipcMain.on('getNames', (event: IpcMainEvent, data: any) =>
      getNames(this, event, data),
    )
    ipcMain.on('getConnectCodes', (event: IpcMainEvent, data: any) =>
      getConnectCodes(this, event, data),
    )
    ipcMain.on(
      'runFilter',
      this.filterExecutor.runFilter.bind(this.filterExecutor),
    )
    ipcMain.on(
      'resumeFilter',
      this.filterExecutor.resumeFilter.bind(this.filterExecutor),
    )
    ipcMain.on(
      'dismissFilterResume',
      this.filterExecutor.dismissFilterResume.bind(this.filterExecutor),
    )
    ipcMain.on(
      'keepFilterResults',
      this.filterExecutor.keepFilterResults.bind(this.filterExecutor),
    )
    ipcMain.on(
      'cancelRunningFilters',
      this.filterExecutor.cancelRunningFilters.bind(this.filterExecutor),
    )
    ipcMain.on(
      'stopRunningFilters',
      this.filterExecutor.stopRunningFilters.bind(this.filterExecutor),
    )
    ipcMain.on(
      'stopFilter',
      this.filterExecutor.stopFilter.bind(this.filterExecutor),
    )
    ipcMain.on(
      'cancelFilter',
      this.filterExecutor.cancelFilter.bind(this.filterExecutor),
    )
    ipcMain.on('getPath', (event: IpcMainEvent, data: any) =>
      getPath(this, event, data),
    )
    ipcMain.on('overlayFontsList', (event: IpcMainEvent, data: any) =>
      overlayFontsList(this, event, data),
    )
    ipcMain.on('overlayFontsImport', (event: IpcMainEvent, data: any) =>
      overlayFontsImport(this, event, data),
    )
    ipcMain.on('overlayFontsRemove', (event: IpcMainEvent, data: any) =>
      overlayFontsRemove(this, event, data),
    )
    ipcMain.on('overlayPreview', (event: IpcMainEvent, data: any) =>
      overlayPreview(this, event, data),
    )
    ipcMain.on(
      'detectDolphinPath',
      this.videoManager.detectDolphinPath.bind(this.videoManager),
    )
    ipcMain.on(
      'detectIsoPath',
      this.videoManager.detectIsoPath.bind(this.videoManager),
    )
    ipcMain.on(
      'detectSlippiReplays',
      this.videoManager.detectSlippiReplays.bind(this.videoManager),
    )
    ipcMain.on(
      'validateDolphinPath',
      this.videoManager.validateDolphinPath.bind(this.videoManager),
    )
    // The tray's overview (docs/tray-v2.md): the next chunk of every row's id,
    // stage and characters, for the far-out GPU view. The renderer pulls chunks.
    ipcMain.on('getOverviewChunk', (event: IpcMainEvent, data: unknown) =>
      this.overview.handleOverviewChunk(event, data),
    )
    // The full-zoom card's Watch panel: the replay file itself, for slippi-viewer.
    ipcMain.on('readReplayFile', (event: IpcMainEvent, data: unknown) =>
      readReplayFile(event, data),
    )
    // The full-zoom card's combo map: both players' positions during a clip.
    ipcMain.on('getClipTrack', (event: IpcMainEvent, data: unknown) =>
      getClipTrack(event, data),
    )
    ipcMain.on(
      'validateIsoPath',
      this.videoManager.validateIsoPath.bind(this.videoManager),
    )
    ipcMain.on(
      'generateVideo',
      this.videoManager.generateVideo.bind(this.videoManager),
    )
    ipcMain.on('stopVideo', this.videoManager.stopVideo.bind(this.videoManager))
    ipcMain.on(
      'cancelVideo',
      this.videoManager.cancelVideo.bind(this.videoManager),
    )
    ipcMain.on(
      'videoToolsList',
      this.videoManager.videoToolsList.bind(this.videoManager),
    )
    ipcMain.on(
      'videoToolsRun',
      this.videoManager.videoToolsRun.bind(this.videoManager),
    )
    ipcMain.on(
      'videoToolsProbe',
      this.videoManager.videoToolsProbe.bind(this.videoManager),
    )
    ipcMain.on(
      'videoToolsCancel',
      this.videoManager.videoToolsCancel.bind(this.videoManager),
    )
    ipcMain.on(
      'videoToolsReveal',
      this.videoManager.videoToolsReveal.bind(this.videoManager),
    )
    ipcMain.on('playClips', this.videoManager.playClips.bind(this.videoManager))
    ipcMain.on('playClip', this.videoManager.playClip.bind(this.videoManager))
    ipcMain.on('stopPlayback', () => this.videoManager.stopPlayback())
    ipcMain.on(
      'recordClip',
      this.videoManager.recordClip.bind(this.videoManager),
    )
    ipcMain.on('removeGame', this.clipManager.removeGame.bind(this.clipManager))
    ipcMain.on(
      'previewRemoveGames',
      this.clipManager.previewRemoveGames.bind(this.clipManager),
    )
    ipcMain.on(
      'removeResult',
      this.clipManager.removeResult.bind(this.clipManager),
    )
    ipcMain.on(
      'reorderClips',
      this.clipManager.reorderClips.bind(this.clipManager),
    )
    ipcMain.on('logPerfEvents', (event: IpcMainEvent, data: any) =>
      logPerfEvents(this, event, data),
    )
    ipcMain.on('debugLog', (event: IpcMainEvent, data: any) =>
      debugLog(this, event, data),
    )
    ipcMain.on(
      'openFolder',
      (event: IpcMainEvent, arg: string | { path: string; create?: boolean }) =>
        openFolder(event, arg),
    )
    ipcMain.on(
      'openDolphinFolder',
      (event: IpcMainEvent, data: RequestEnvelope<string>) =>
        openDolphinFolder(event, data),
    )
    // "Run once" for custom code: this session only (customCodeApproval.ts).
    ipcMain.on(
      'approveCustomCodeOnce',
      (_event: IpcMainEvent, hashes: unknown) => approveOnce(hashes),
    )
    ipcMain.on('openLogsFolder', () => openLogsFolder())
    ipcMain.on('getLogsPath', (event: IpcMainEvent) => getLogsPath(event))
    ipcMain.on(
      'exportLogs',
      (event: IpcMainEvent, data: RequestEnvelope<null>) =>
        exportLogs(event, data),
    )
    ipcMain.on('getAppVersion', (event: IpcMainEvent) => getAppVersion(event))
    ipcMain.on('resetConfig', (event: IpcMainEvent, data?: unknown) =>
      resetConfig(this, event, data),
    )
    ipcMain.on('resetApp', (event: IpcMainEvent, data?: any) =>
      resetApp(this, event, data),
    )
    ipcMain.on('hasDevBackup', (event: IpcMainEvent) =>
      hasDevBackup(this, event),
    )
    ipcMain.on('restoreDevBackup', () => restoreDevBackup(this))
    ipcMain.on('openExternal', (event: IpcMainEvent, url: string) =>
      openExternal(event, url),
    )
    ipcMain.on('rendererError', (event: IpcMainEvent, data: any) =>
      logRendererError(this, event, data),
    )
    ipcMain.on(
      'testDolphin',
      this.videoManager.testDolphin.bind(this.videoManager),
    )
    ipcMain.on(
      'openCodeEditor',
      this.codeEditorManager.openCodeEditor.bind(this.codeEditorManager),
    )
    ipcMain.on(
      'openCodeEditorForTemplate',
      this.codeEditorManager.openCodeEditorForTemplate.bind(
        this.codeEditorManager,
      ),
    )
  }
}
