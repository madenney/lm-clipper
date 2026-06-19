import {
  app,
  ipcMain,
  dialog,
  shell,
  IpcMainEvent,
  BrowserWindow,
} from 'electron'
import { Worker } from 'worker_threads'
import { randomUUID } from 'crypto'
import os from 'os'
import path from 'path'
import fs, { promises as fsPromises } from 'fs'
import { getWorkerExecArgv } from '../lib'
import { getDescendantIds } from '../lib/filterGraph'
import { ensureProjectExt, projectDisplayName } from './projectFile'
import { detectPlaybackDolphin, detectMeleeIso } from './slippiDetect'
import { config as defaultConfig } from '../constants/defaults'
import { filtersConfig } from '../constants/config'
import {
  ArchiveInterface,
  ConfigInterface,
  FilterInterface,
  ShallowFilterInterface,
} from '../constants/types'
import Archive from '../models/Archive'
import Filter from '../models/Filter'
import { setFFMPEGPathOverride } from './slpToVideo'
import { getMetaData, createDB } from './db'
import {
  getTableCountAsync,
  getFilterCountAsync,
  getTableDurationAsync,
  getAllIdsAsync,
  deleteFilterRunAsync,
  updateMetadataNameAsync,
  updateMetadataPathAndNameAsync,
} from './dbAsync'
import { closeDb } from './dbConnection'
import { appendPerfEvents } from './perfLogger'
import { logMain, logRenderer, getLogPath } from './logger'
import { initTelemetry, track } from './telemetry'
import { RequestEnvelope, unpackRequest, reply } from './ipcUtils'
import ConsoleManager from './managers/ConsoleManager'
import ImportManager from './managers/ImportManager'
import FilterExecutor from './managers/FilterExecutor'
import VideoManager from './managers/VideoManager'
import ClipManager from './managers/ClipManager'
import CodeEditorManager from './managers/CodeEditorManager'

function getDefaultProjectDir(): string {
  // User-created projects are documents — keep them where users actually browse
  // (a "Lunar Clipper" folder under Documents), consistently on every platform,
  // not buried in a hidden config/data dir.
  return path.resolve(app.getPath('documents'), 'Lunar Clipper')
}

// Sensible default filter-thread count from the user's CPU: leave ~2 cores for
// the UI + DB worker, capped to keep per-worker memory in check.
function autoFilterThreads(): number {
  const cores = os.cpus().length || 2
  return Math.min(Math.max(cores - 2, 1), 8)
}

// Regenerate the source of src/constants/rectangles.ts from edited rectangles.
type RectBox = { xMin: number; xMax: number; yMin: number; yMax: number }
function buildRectanglesFile(
  rects: Record<string, { name: string; bz: RectBox; edge: RectBox }>,
): string {
  const fmt = (b: RectBox) =>
    `{ xMin: ${b.xMin}, xMax: ${b.xMax}, yMin: ${b.yMin}, yMax: ${b.yMax} }`
  const ids = Object.keys(rects)
    .map((k) => parseInt(k, 10))
    .filter((n) => !Number.isNaN(n))
    .sort((a, b) => a - b)
  const entries = ids
    .map((id) => {
      const e = rects[id]
      const name = String(e.name).replace(/'/g, "\\'")
      return `  ${id}: {\n    name: '${name}',\n    bz: ${fmt(e.bz)},\n    edge: ${fmt(e.edge)},\n  },`
    })
    .join('\n')
  return `// Stage boundary rectangles for edgeguard detection
// Keyed by Slippi stage ID. Coordinates define right-side regions;
// the left side is mirrored by negating X values.
//   bz   – blast zone (outside = death)
//   edge – ledge/edge region used to detect offstage situations

const rectangles: Record<
  number,
  {
    name: string
    bz: { xMin: number; xMax: number; yMin: number; yMax: number }
    edge: { xMin: number; xMax: number; yMin: number; yMax: number }
  }
> = {
${entries}
}

export default rectangles
`
}

export default class Controller {
  mainWindow: BrowserWindow
  configDir: string
  configPath: string
  archive: ArchiveInterface | null
  private archiveVersion = 0
  config: ConfigInterface
  nameCountWorker: Worker | null
  private countWorkerExecArgv?: string[]

  // Fired once, the first time the renderer requests the archive (i.e. once it
  // has mounted and registered its IPC listeners). main.ts uses this to safely
  // flush an OS-initiated "open this .lunar file" without racing the renderer.
  onRendererReady: (() => void) | null = null

  private rendererReadyFired = false

  // Managers
  consoleManager: ConsoleManager
  importManager: ImportManager
  filterExecutor: FilterExecutor
  videoManager: VideoManager
  clipManager: ClipManager
  codeEditorManager: CodeEditorManager

  constructor(mainWindow: BrowserWindow) {
    this.mainWindow = mainWindow
    this.configDir = path.resolve(app.getPath('appData'), 'lm-clipper')
    if (!fs.existsSync(this.configDir)) fs.mkdirSync(this.configDir)
    this.configPath = path.resolve(this.configDir, 'lm-clipper.json')
    const isFirstRun = !fs.existsSync(this.configPath)
    if (isFirstRun)
      fs.writeFileSync(this.configPath, JSON.stringify(defaultConfig, null, 2))

    let loadedConfig: any
    try {
      loadedConfig = JSON.parse(fs.readFileSync(this.configPath).toString())
    } catch {
      loadedConfig = {}
    }
    this.config = { ...defaultConfig, ...loadedConfig }
    if (isFirstRun) {
      // First run: pick a sensible filter-thread count from the user's CPU.
      // (Video/Dolphin parallelism stays conservative; set separately.)
      this.config.numFilterThreads = autoFilterThreads()
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
    if (typeof this.config.resolution === 'string') {
      const resolutionMap: { [key: string]: number } = {
        '1x': 2,
        '1.5x': 3,
        '2x': 4,
        '2.5x': 5,
        '3x': 6,
        '4x': 7,
        '5x': 8,
        '6x': 9,
        '7x': 10,
        '8x': 11,
      }
      if (resolutionMap[this.config.resolution]) {
        this.config.resolution = resolutionMap[this.config.resolution]
      }
    }
    const intKeys = [
      'numCPUs',
      'slice',
      'bitrateKbps',
      'addStartFrames',
      'addEndFrames',
      'lastClipOffset',
      'numFilterThreads',
      'dolphinCutoff',
    ]
    intKeys.forEach((key) => {
      if (typeof this.config[key] === 'string') {
        const parsed = parseInt(this.config[key], 10)
        if (!Number.isNaN(parsed)) {
          this.config[key] = parsed
        }
      }
    })
    // Anonymous, random per-install id (not a machine fingerprint). Generated
    // once and persisted via the saveConfig() below; also set for existing
    // users upgrading from a build that predates telemetry.
    if (!this.config.installId) {
      this.config.installId = randomUUID()
    }
    this.saveConfig()
    if (this.config.ffmpegPath) {
      setFFMPEGPathOverride(this.config.ffmpegPath)
    }
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
      getConfig: () => this.config,
      getConfigPath: () => this.configPath,
      getArchive: () => this.archive,
      setArchive: setArchiveWithVersion,
      getArchiveVersion: () => this.archiveVersion,
      autoCreateUntitledProject: () => this.autoCreateUntitledProject(),
      consoleManager: this.consoleManager,
    })

    this.filterExecutor = new FilterExecutor(mainWindow, {
      getArchive: () => this.archive,
      setArchive: setArchiveWithVersion,
      getArchiveVersion: () => this.archiveVersion,
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
    })

    this.codeEditorManager = new CodeEditorManager(mainWindow, {
      getArchive: () => this.archive,
      getConfig: () => this.config,
      getConfigPath: () => this.configPath,
      saveConfig: () => {
        this.saveConfig()
      },
    })

    // Anonymous usage telemetry (opt-out: Settings → Send Anonymous Usage Data).
    initTelemetry({ getConfig: () => this.config })
    this.reportStartupTelemetry(isFirstRun)
  }

  // Fire the install (once-ever) + app_open (once-per-day) usage events.
  private reportStartupTelemetry(isFirstRun: boolean) {
    if (isFirstRun) track('install')
    const today = new Date().toISOString().slice(0, 10)
    if (this.config.lastUsagePing !== today) {
      this.config.lastUsagePing = today
      this.saveConfig()
      track('app_open')
    }
  }

  private saveConfig() {
    return fsPromises.writeFile(
      this.configPath,
      JSON.stringify(this.config, null, 2),
    )
  }

  private setArchiveInternal(a: ArchiveInterface | null) {
    this.archive = a
    this.archiveVersion += 1
    this.updateWindowTitle()
  }

  private updateWindowTitle() {
    if (this.mainWindow?.isDestroyed?.()) return
    const name = this.archive?.name
    this.mainWindow.setTitle(name ? `Lunar Clipper — ${name}` : 'Lunar Clipper')
  }

  cleanup() {
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

    // Close code editor window and clean up its IPC listeners
    this.codeEditorManager.cleanup()
  }

  private addToRecentProjects(name: string, projectPath: string) {
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
  }

  private removeFromRecentProjects(projectPath: string) {
    if (!this.config.recentProjects) return
    this.config.recentProjects = this.config.recentProjects.filter(
      (p) => p.path !== projectPath,
    )
    this.saveConfig()
  }

  private getUntitledName(dir: string): string {
    let name = 'Untitled'
    let counter = 1
    while (fs.existsSync(ensureProjectExt(path.resolve(dir, name)))) {
      counter += 1
      name = `Untitled ${counter}`
    }
    return name
  }

  private async autoCreateUntitledProject() {
    const docsDir = getDefaultProjectDir()
    if (!fs.existsSync(docsDir)) fs.mkdirSync(docsDir, { recursive: true })
    const name = this.getUntitledName(docsDir)
    const metadata = await this.createNewArchiveInternal({
      name,
      location: docsDir,
    })
    return metadata
  }

  private async createNewArchiveInternal(payload: {
    name?: string
    location?: string
  }) {
    this.stopNameCountWorker()
    closeDb()
    const newArchivePath = ensureProjectExt(
      path.resolve(
        payload.location || getDefaultProjectDir(),
        `${payload.name ? payload.name : 'lm-clipper-default-db'}`,
      ),
    )
    const displayName = projectDisplayName(newArchivePath)

    await createDB(
      newArchivePath,
      displayName,
      this.config.includeDefaultFilters !== false,
    )
    const metadata = await getMetaData(newArchivePath)
    this.setArchiveInternal(new Archive(metadata))

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
        const metadata = await getMetaData(this.config.lastArchivePath)
        this.setArchiveInternal(new Archive(metadata))
        this.updateWindowTitle()
        return
      } catch (e) {
        console.error('error fetching from last archive path')
      }
    }

    // Stale path — clear it
    console.log('Last archive path not found, clearing')
    this.config.lastArchivePath = null
    this.saveConfig()
    this.setArchiveInternal(null)
  }

  async getConfig(event: IpcMainEvent, data?: RequestEnvelope<null>) {
    const { requestId } = unpackRequest<null>(data)
    reply(event, 'config', requestId, this.config)
  }

  async setDefaultOutputPath(
    event: IpcMainEvent,
    data?: RequestEnvelope<null>,
  ) {
    const { requestId } = unpackRequest<null>(data)
    this.ensureDefaultOutputPath()
    reply(event, 'setDefaultOutputPath', requestId, this.config.outputPath)
  }

  private ensureDefaultOutputPath() {
    if (!this.config.outputPath) {
      this.config.outputPath = path.join(
        app.getPath('videos') || app.getPath('home'),
        'Lunar Clipper',
      )
      this.saveConfig()
    }
  }

  async updateConfig(
    event: IpcMainEvent,
    data: RequestEnvelope<{
      key: string
      value: string | number | boolean | null
    }>,
  ) {
    const { requestId, payload } = unpackRequest<{
      key: string
      value: string | number | boolean | null
    }>(data)
    if (!payload) {
      return reply(event, 'updateConfig', requestId)
    }
    this.config[payload.key] = payload.value
    if (payload.key === 'ffmpegPath') {
      setFFMPEGPathOverride(payload.value as string)
    }
    this.saveConfig()
    return reply(event, 'updateConfig', requestId)
  }

  async getArchive(event: IpcMainEvent, data?: RequestEnvelope<null>) {
    const { requestId } = unpackRequest<null>(data)
    if (this.archive) {
      try {
        this.stopNameCountWorker()
        const metadata = await getMetaData(this.archive.path)
        this.setArchiveInternal(new Archive(metadata))
        this.updateWindowTitle()
        reply(event, 'archive', requestId, metadata)
      } catch (error) {
        console.error('Error loading archive metadata:', error)
        this.setArchiveInternal(null)
        this.config.lastArchivePath = null
        this.saveConfig()
        reply(event, 'archive', requestId)
      }
    } else {
      reply(event, 'archive', requestId)
    }

    // The renderer has mounted and registered its listeners by the time it
    // first asks for the archive — safe point to flush a pending OS file open.
    if (!this.rendererReadyFired) {
      this.rendererReadyFired = true
      this.onRendererReady?.()
    }
  }

  async createNewArchive(
    event: IpcMainEvent,
    data: RequestEnvelope<{ name?: string; location?: string }>,
  ) {
    try {
      const { requestId, payload } = unpackRequest<{
        name?: string
        location?: string
      }>(data)
      const metadata = await this.createNewArchiveInternal(payload || {})
      reply(event, 'createNewArchive', requestId, metadata)
    } catch (error) {
      const { requestId } = unpackRequest<{
        name?: string
        location?: string
      }>(data)
      reply(event, 'createNewArchive', requestId, { error: true, info: error })
    }
  }

  async getDirectory(event: IpcMainEvent, data?: RequestEnvelope<null>) {
    const { requestId } = unpackRequest<null>(data)
    try {
      const { canceled, filePaths } = await dialog.showOpenDialog({
        properties: ['openDirectory'],
        defaultPath: this.config.lastArchivePath
          ? this.config.lastArchivePath
          : '',
      })
      if (canceled) return reply(event, 'directory', requestId)
      return reply(event, 'directory', requestId, filePaths[0])
    } catch (error) {
      console.error('[getDirectory] error:', error)
      return reply(event, 'directory', requestId)
    }
  }

  async openExistingArchive(event: IpcMainEvent, data?: RequestEnvelope<null>) {
    const { requestId } = unpackRequest<null>(data)
    try {
      const { canceled, filePaths } = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [
          { name: 'Lunar Clipper Project', extensions: ['lunar'] },
          { name: 'All Files', extensions: ['*'] },
        ],
        defaultPath: this.config.lastArchivePath
          ? path.dirname(this.config.lastArchivePath)
          : undefined,
      })
      if (canceled) return reply(event, 'openExistingArchive', requestId)

      this.stopNameCountWorker()
      closeDb()
      try {
        const metadata = await getMetaData(filePaths[0])
        this.setArchiveInternal(new Archive(metadata))
        this.updateWindowTitle()
      } catch (e) {
        console.error('Error opening archive', e)
        return reply(event, 'openExistingArchive', requestId, {
          error: 'Failed to open given filepath',
        })
      }

      if (!this.archive || !this.archive.shallowCopy)
        throw new Error('Something went wrong :(')

      // Fix legacy projects whose name is still "Untitled"
      if (/^Untitled(\s\d+)?$/.test(this.archive.name)) {
        const derivedName = projectDisplayName(filePaths[0])
        await updateMetadataNameAsync(filePaths[0], derivedName)
        this.archive.name = derivedName
      }

      this.config.lastArchivePath = this.archive.path
      this.config.projectName = this.archive.name
      this.saveConfig()
      this.addToRecentProjects(this.archive.name, this.archive.path)
      const metadata = await this.archive.shallowCopy()
      return reply(event, 'openExistingArchive', requestId, metadata)
    } catch (error) {
      return reply(event, 'openExistingArchive', requestId, { error })
    }
  }

  async closeArchive(event: IpcMainEvent, data?: RequestEnvelope<null>) {
    const { requestId } = unpackRequest<null>(data)
    this.stopNameCountWorker()
    closeDb()
    this.setArchiveInternal(null)
    this.config.lastArchivePath = null
    this.saveConfig()
    this.importManager.setImportStatus({
      isImporting: false,
      current: 0,
      total: null,
      queueLength: 0,
    })
    return reply(event, 'closeArchive', requestId)
  }

  async newProject(event: IpcMainEvent, data?: RequestEnvelope<null>) {
    const { requestId } = unpackRequest<null>(data)
    try {
      // Auto-create an "Untitled" project immediately — no save dialog. Matches
      // the relaxed, expected flow (and the auto-create-on-import behavior).
      // The user renames / relocates later via Save As. New projects land next
      // to the last one (or in the default project dir for a fresh user).
      const location = this.config.lastArchivePath
        ? path.dirname(this.config.lastArchivePath)
        : getDefaultProjectDir()
      if (!fs.existsSync(location)) fs.mkdirSync(location, { recursive: true })
      const name = this.getUntitledName(location)
      logMain('newProject: auto-creating', { name, location })
      const metadata = await this.createNewArchiveInternal({ name, location })
      logMain('newProject: created successfully')
      return reply(event, 'newProject', requestId, metadata)
    } catch (error) {
      logMain('newProject: error', error)
      return reply(event, 'newProject', requestId, { error: true, info: error })
    }
  }

  async saveAsArchive(event: IpcMainEvent, data?: RequestEnvelope<null>) {
    const { requestId } = unpackRequest<null>(data)
    if (!this.archive) {
      return reply(event, 'saveAsArchive', requestId, {
        error: 'No project open',
      })
    }

    const { canceled, filePath: rawPath } = await dialog.showSaveDialog({
      title: 'Save Project As',
      defaultPath: path.resolve(
        path.dirname(this.archive.path),
        this.archive.name,
      ),
      filters: [{ name: 'Lunar Clipper Project', extensions: ['lunar'] }],
    })
    if (canceled || !rawPath) {
      return reply(event, 'saveAsArchive', requestId)
    }

    const newPath = ensureProjectExt(rawPath)
    try {
      const oldPath = this.archive.path
      this.stopNameCountWorker()
      closeDb()
      await fsPromises.copyFile(oldPath, newPath)

      // Update the stored path and name inside the DB
      const newName = projectDisplayName(newPath)
      await updateMetadataPathAndNameAsync(newPath, newPath, newName)

      const metadata = await getMetaData(newPath)
      this.setArchiveInternal(new Archive(metadata))
      this.updateWindowTitle()

      this.config.lastArchivePath = newPath
      this.config.projectName = newName
      this.saveConfig()
      this.addToRecentProjects(newName, newPath)

      const shallow = await this.archive.shallowCopy!()
      return reply(event, 'saveAsArchive', requestId, shallow)
    } catch (error) {
      console.error('Error saving project as:', error)
      return reply(event, 'saveAsArchive', requestId, {
        error: true,
        info: error,
      })
    }
  }

  async getRecentProjects(event: IpcMainEvent, data?: RequestEnvelope<null>) {
    const { requestId } = unpackRequest<null>(data)
    const recents = (this.config.recentProjects || []).filter((p) =>
      fs.existsSync(p.path),
    )
    // Update stored list to remove stale entries
    if (recents.length !== (this.config.recentProjects || []).length) {
      this.config.recentProjects = recents
      this.saveConfig()
    }
    return reply(event, 'getRecentProjects', requestId, recents)
  }

  async openRecentProject(event: IpcMainEvent, data: RequestEnvelope<string>) {
    const { requestId, payload: projectPath } = unpackRequest<string>(data)
    if (!projectPath || !fs.existsSync(projectPath)) {
      if (projectPath) this.removeFromRecentProjects(projectPath)
      return reply(event, 'openRecentProject', requestId, {
        error: 'Project file not found',
      })
    }

    try {
      this.stopNameCountWorker()
      closeDb()
      const metadata = await getMetaData(projectPath)
      this.setArchiveInternal(new Archive(metadata))
      this.updateWindowTitle()
      if (!this.archive || !this.archive.shallowCopy) {
        throw new Error('Failed to load project')
      }
      // Fix legacy projects whose name is still "Untitled"
      if (/^Untitled(\s\d+)?$/.test(this.archive.name)) {
        const derivedName = path.basename(projectPath)
        await updateMetadataNameAsync(projectPath, derivedName)
        this.archive.name = derivedName
      }

      this.config.lastArchivePath = projectPath
      this.config.projectName = this.archive.name
      this.saveConfig()
      this.addToRecentProjects(this.archive.name, projectPath)
      const shallow = await this.archive.shallowCopy()
      return reply(event, 'openRecentProject', requestId, shallow)
    } catch (error) {
      console.error('Error opening recent project:', error)
      return reply(event, 'openRecentProject', requestId, {
        error: true,
        info: error,
      })
    }
  }

  async addFilter(event: IpcMainEvent, data: RequestEnvelope<string>) {
    const { requestId, payload } = unpackRequest<string>(data)
    if (!this.archive) {
      try {
        await this.createNewArchiveInternal({
          name: this.config.projectName || undefined,
        })
      } catch (error) {
        console.error('Error creating default DB:', error)
      }
    }
    if (!this.archive || !this.archive.shallowCopy || !this.archive.addFilter)
      return reply(event, 'addFilter', requestId, {
        error: 'archive undefined',
      })
    if (payload === 'default') {
      return reply(event, 'addFilter', requestId, {
        error: 'invalid filter type',
      })
    }

    // Handle saved custom templates: "customTemplate:INDEX"
    const isCustomTemplate = payload?.startsWith('customTemplate:')
    const filterType = isCustomTemplate ? 'custom' : payload
    const template = filtersConfig.find((p) => p.id === filterType)
    if (!template) {
      throw Error(`Invalid Filter Type ${payload}`)
    }

    const existingIds = new Set(this.archive.filters.map((f) => f.id))
    let newFilterId: string
    do {
      const randomNum = Math.floor(1000 + Math.random() * 90000)
      newFilterId = `filter_${randomNum}`
    } while (existingIds.has(newFilterId))

    const newFilterJSON: FilterInterface = {
      id: newFilterId,
      results: 0,
      type: template.id,
      isProcessed: false,
      label: template.label,
      params: {},
    }
    template.options.forEach((option) => {
      newFilterJSON.params[option.id] = option.default
    })
    if (template.id === 'sort') {
      const hasParser = this.archive.filters.some((f) => f.type === 'slpParser')
      if (!hasParser) {
        newFilterJSON.params.sortFunction = 'chronological'
      }
    }

    // Pre-fill from saved custom template
    if (isCustomTemplate) {
      const templateIndex = parseInt(payload!.split(':')[1], 10)
      const saved = this.config.savedCustomFilters?.[templateIndex]
      if (saved) {
        newFilterJSON.label = saved.name
        newFilterJSON.params.code = saved.code
        if (saved.customParams) {
          newFilterJSON.params.customParams = JSON.parse(
            JSON.stringify(saved.customParams),
          )
        }
        if (saved.outputFields) {
          newFilterJSON.params.outputFields = JSON.parse(
            JSON.stringify(saved.outputFields),
          )
        }
      }
    }

    try {
      await this.archive.addFilter(newFilterJSON)
      const metadata = await this.archive.shallowCopy()
      return reply(event, 'addFilter', requestId, metadata)
    } catch (error) {
      console.error('[addFilter] error:', error)
      return reply(event, 'addFilter', requestId, {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  async removeFilter(event: IpcMainEvent, data: RequestEnvelope<string>) {
    const { requestId, payload } = unpackRequest<string>(data)
    if (
      !this.archive ||
      !this.archive.shallowCopy ||
      !this.archive.deleteFilter
    ) {
      return reply(event, 'removeFilter', requestId, {
        error: 'archive undefined',
      })
    }

    const target = this.archive.filters.find((filter) => filter.id === payload)
    if (target?.type === 'files') {
      return reply(event, 'removeFilter', requestId, {
        error: 'cannot remove game filter',
      })
    }

    try {
      if (payload) {
        const _t0 = Date.now()
        await deleteFilterRunAsync(this.archive.path, payload)
        console.log(`[removeFilter] deleteFilterRun took ${Date.now() - _t0}ms`)
        const _t1 = Date.now()
        await this.archive.deleteFilter(payload)
        console.log(`[removeFilter] deleteFilter took ${Date.now() - _t1}ms`)
      }
      const _t2 = Date.now()
      const metadata = await this.archive.shallowCopy()
      console.log(`[removeFilter] shallowCopy took ${Date.now() - _t2}ms`)
      return reply(event, 'removeFilter', requestId, metadata)
    } catch (error) {
      console.error('[removeFilter] error:', error)
      return reply(event, 'removeFilter', requestId, {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // removeGame, removeResult, reorderClips → ClipManager

  async saveCustomFilter(
    event: IpcMainEvent,
    data: RequestEnvelope<{
      name: string
      code: string
      customParams?: { name: string; type: string; value: string }[]
      outputFields?: { name: string; type: string }[]
    }>,
  ) {
    const { requestId, payload } = unpackRequest<{
      name: string
      code: string
      customParams?: { name: string; type: string; value: string }[]
      outputFields?: { name: string; type: string }[]
    }>(data)
    if (!payload?.name || !payload?.code) {
      return reply(event, 'saveCustomFilter', requestId, {
        error: 'missing name or code',
      })
    }
    if (!this.config.savedCustomFilters) {
      this.config.savedCustomFilters = []
    }
    // Update existing template with same name, or add new
    const existing = this.config.savedCustomFilters.findIndex(
      (t) => t.name === payload.name,
    )
    const entry = {
      name: payload.name,
      code: payload.code,
      customParams: payload.customParams,
      outputFields: payload.outputFields,
    }
    if (existing >= 0) {
      this.config.savedCustomFilters[existing] = entry
    } else {
      this.config.savedCustomFilters.push(entry)
    }
    this.saveConfig()
    return reply(event, 'saveCustomFilter', requestId, {
      savedCustomFilters: this.config.savedCustomFilters,
    })
  }

  async deleteCustomFilter(event: IpcMainEvent, data: RequestEnvelope<number>) {
    const { requestId, payload } = unpackRequest<number>(data)
    if (
      !this.config.savedCustomFilters ||
      typeof payload !== 'number' ||
      payload < 0 ||
      payload >= this.config.savedCustomFilters.length
    ) {
      return reply(event, 'deleteCustomFilter', requestId, {
        error: 'invalid index',
      })
    }
    this.config.savedCustomFilters.splice(payload, 1)
    this.saveConfig()
    return reply(event, 'deleteCustomFilter', requestId, {
      savedCustomFilters: this.config.savedCustomFilters,
    })
  }

  async reorderFilter(
    event: IpcMainEvent,
    data: RequestEnvelope<{ fromIndex: number; toIndex: number }>,
  ) {
    const { requestId, payload } = unpackRequest<{
      fromIndex: number
      toIndex: number
    }>(data)
    if (!payload) {
      return reply(event, 'reorderFilter', requestId, {
        error: 'missing payload',
      })
    }
    if (!this.archive || !this.archive.shallowCopy) {
      return reply(event, 'reorderFilter', requestId, {
        error: 'archive undefined',
      })
    }

    const { fromIndex, toIndex } = payload
    const filters = this.archive.filters

    // Validate indices
    if (
      fromIndex < 1 ||
      toIndex < 1 ||
      fromIndex >= filters.length ||
      toIndex >= filters.length ||
      fromIndex === toIndex
    ) {
      return reply(event, 'reorderFilter', requestId, {
        error: 'invalid indices',
      })
    }

    // Splice: remove from old position, insert at new position
    const [moved] = filters.splice(fromIndex, 1)
    filters.splice(toIndex, 0, moved)

    // A filter may only read from `files` or a filter ABOVE it. If a move turned
    // an explicit inputId into a forward (or self) reference, drop it so the
    // filter reverts to reading from the card directly above it.
    for (let i = 0; i < filters.length; i += 1) {
      const inputId = filters[i].inputId
      if (!inputId || inputId === 'files') continue
      const sourceIdx = filters.findIndex((f) => f.id === inputId)
      if (sourceIdx === -1 || sourceIdx >= i) {
        delete filters[i].inputId
      }
    }

    // Mark all filters from the earliest affected index onward as unprocessed
    const start = Math.min(fromIndex, toIndex)
    for (let i = start; i < filters.length; i += 1) {
      filters[i].isProcessed = false
      filters[i].results = 0
    }

    // Reset parser-dependent params for filters that no longer have a parser above them
    const hasParserAbove = (idx: number) =>
      filters.slice(0, idx).some((f) => f.type === 'slpParser')

    for (let i = 0; i < filters.length; i += 1) {
      if (hasParserAbove(i)) continue
      const fc = filtersConfig.find((c) => c.id === filters[i].type)
      if (!fc?.options) continue
      for (const opt of fc.options as any[]) {
        if (opt.requiresParser && filters[i].params?.[opt.id] !== undefined) {
          filters[i].params[opt.id] = opt.default ?? ''
        }
        if (
          opt.type === 'dropdown' &&
          opt.options &&
          filters[i].params?.[opt.id]
        ) {
          const selected = opt.options.find(
            (e: any) => e.id === filters[i].params[opt.id],
          )
          if (selected?.requiresParser) {
            filters[i].params[opt.id] = opt.default ?? ''
          }
        }
      }
    }

    try {
      if (this.archive.saveMetaData) await this.archive.saveMetaData()
      return reply(
        event,
        'reorderFilter',
        requestId,
        await this.archive.shallowCopy(),
      )
    } catch (error) {
      console.error('[reorderFilter] error:', error)
      return reply(event, 'reorderFilter', requestId, {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // Dev tuning tool: rewrite src/constants/rectangles.ts from edited edgeguard
  // rectangles (the Stage Zone editor in edge-rect mode). Only works in dev,
  // where the source tree exists on disk.
  async saveEdgeRectangles(
    event: IpcMainEvent,
    data: RequestEnvelope<
      Record<
        string,
        {
          name: string
          bz: { xMin: number; xMax: number; yMin: number; yMax: number }
          edge: { xMin: number; xMax: number; yMin: number; yMax: number }
        }
      >
    >,
  ) {
    const { requestId, payload } =
      unpackRequest<
        Record<string, { name: string; bz: RectBox; edge: RectBox }>
      >(data)
    if (!payload || typeof payload !== 'object') {
      return reply(event, 'saveEdgeRectangles', requestId, {
        error: 'missing rectangles',
      })
    }
    try {
      const filePath = path.resolve(
        app.getAppPath(),
        'src',
        'constants',
        'rectangles.ts',
      )
      await fsPromises.access(filePath)
      await fsPromises.writeFile(filePath, buildRectanglesFile(payload))
      return reply(event, 'saveEdgeRectangles', requestId, {
        success: true,
        path: filePath,
      })
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      return reply(event, 'saveEdgeRectangles', requestId, {
        error: `Could not write rectangles.ts (only works in dev): ${msg}`,
      })
    }
  }

  async updateFilter(
    event: IpcMainEvent,
    data: RequestEnvelope<{
      filterIndex: number
      newFilter: ShallowFilterInterface
    }>,
  ) {
    const { requestId, payload } = unpackRequest<{
      filterIndex: number
      newFilter: ShallowFilterInterface
    }>(data)
    if (!payload) {
      return reply(event, 'updateFilter', requestId, {
        error: 'missing payload',
      })
    }
    const { newFilter, filterIndex } = payload
    if (!this.archive || !this.archive.shallowCopy)
      return reply(event, 'updateFilter', requestId, {
        error: 'archive undefined',
      })
    try {
      this.archive.filters[filterIndex] = new Filter({
        ...newFilter,
        isProcessed: false,
        results: 0,
      })
      // Invalidate only filters that read from this one (transitively). In a
      // linear chain that's everything below; with branches it leaves unrelated
      // branches alone.
      const editedId = this.archive.filters[filterIndex].id
      const descendants = getDescendantIds(
        this.archive.filters,
        editedId,
        this.config.branchingEnabled === true,
      )
      this.archive.filters.forEach((filter) => {
        if (descendants.has(filter.id)) {
          filter.isProcessed = false
          filter.results = 0
        }
      })
      if (this.archive.saveMetaData) await this.archive.saveMetaData()
      return reply(
        event,
        'updateFilter',
        requestId,
        await this.archive.shallowCopy(),
      )
    } catch (error) {
      console.error('[updateFilter] error:', error)
      return reply(event, 'updateFilter', requestId, {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  async getResults(
    event: IpcMainEvent,
    data: RequestEnvelope<{
      filterId: string
      currentPage?: number
      numPerPage?: number
      offset?: number
      limit?: number
      lite?: boolean
    }>,
  ) {
    const { requestId, payload } = unpackRequest<{
      filterId: string
      currentPage?: number
      numPerPage?: number
      offset?: number
      limit?: number
      lite?: boolean
    }>(data)
    if (!this.archive || !this.archive.getItems || !payload) {
      return reply(event, 'getResults', requestId, { items: [], total: 0 })
    }
    const { filterId, numPerPage, currentPage, offset, limit, lite } = payload
    console.log('Selected filter: ', filterId)

    try {
      // Use the already-known cached count instead of a fresh COUNT(*). On a
      // 48M-row table that scan is ~30s and was running on EVERY page fetch,
      // blocking the whole tray. The count is already in the in-memory archive
      // (hydrated on open); only fall back to a live count if it's unknown.
      const cachedTotal =
        filterId === 'files'
          ? this.archive.files
          : this.archive.filters.find((f) => f.id === filterId)?.results
      const [items, total] = await Promise.all([
        this.archive.getItems({
          filterId,
          numPerPage,
          currentPage,
          offset,
          limit,
          lite,
        }),
        typeof cachedTotal === 'number'
          ? Promise.resolve(cachedTotal)
          : getTableCountAsync(this.archive.path, filterId),
      ])
      reply(event, 'getResults', requestId, { items, total })
    } catch (error) {
      console.error('Error fetching results:', error)
      reply(event, 'getResults', requestId, { items: [], total: 0 })
    }
  }

  async getAllResultIds(
    event: IpcMainEvent,
    data: RequestEnvelope<{ filterId: string }>,
  ) {
    const { requestId, payload } = unpackRequest<{ filterId: string }>(data)
    if (!this.archive || !payload?.filterId) {
      return reply(event, 'getAllResultIds', requestId, [])
    }
    try {
      const ids = await getAllIdsAsync(this.archive.path, payload.filterId)
      return reply(event, 'getAllResultIds', requestId, ids)
    } catch (error) {
      console.error('[getAllResultIds] error:', error)
      return reply(event, 'getAllResultIds', requestId, [])
    }
  }

  async getTableDuration(
    event: IpcMainEvent,
    data: RequestEnvelope<{ filterId: string }>,
  ) {
    const { requestId, payload } = unpackRequest<{ filterId: string }>(data)
    if (!this.archive || !payload?.filterId) {
      return reply(event, 'getTableDuration', requestId, 0)
    }
    try {
      const total = await getTableDurationAsync(
        this.archive.path,
        payload.filterId,
      )
      return reply(event, 'getTableDuration', requestId, total)
    } catch (error) {
      console.error('[getTableDuration] error:', error)
      return reply(event, 'getTableDuration', requestId, 0)
    }
  }

  // Lazy count hydration: the renderer calls this per-filter after a project
  // opens to fill in the result counts that getMetadata intentionally left null
  // (so open never blocks on a full-table COUNT(*)). Runs in the DbWorker thread
  // and caches the result for instant subsequent opens.
  async getFilterCount(
    event: IpcMainEvent,
    data: RequestEnvelope<{ filterId: string }>,
  ) {
    const { requestId, payload } = unpackRequest<{ filterId: string }>(data)
    if (!this.archive || !payload?.filterId) {
      return reply(event, 'getFilterCount', requestId, {
        filterId: payload?.filterId,
        count: 0,
      })
    }
    try {
      const count = await getFilterCountAsync(
        this.archive.path,
        payload.filterId,
      )
      // Keep the in-memory archive's count in sync so getResults can use it
      // instead of a fresh COUNT(*) on subsequent fetches.
      if (this.archive) {
        if (payload.filterId === 'files') {
          this.archive.files = count
        } else {
          const f = this.archive.filters.find((x) => x.id === payload.filterId)
          if (f) f.results = count
        }
      }
      return reply(event, 'getFilterCount', requestId, {
        filterId: payload.filterId,
        count,
      })
    } catch (error) {
      console.error('[getFilterCount] error:', error)
      return reply(event, 'getFilterCount', requestId, {
        filterId: payload.filterId,
        count: 0,
      })
    }
  }

  private stopNameCountWorker() {
    if (!this.nameCountWorker) return
    const worker = this.nameCountWorker
    this.nameCountWorker = null
    worker.terminate().catch(() => {})
  }

  private ensureNameCountWorker(): Worker {
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

  async getNames(event: IpcMainEvent, data?: RequestEnvelope<null>) {
    const { requestId } = unpackRequest<null>(data)
    if (!this.archive) return reply(event, 'getNames', requestId, [])

    try {
      const worker = this.ensureNameCountWorker()
      const t0 = Date.now()
      const result = await new Promise<{ name: string; total: number }[]>(
        (resolve, reject) => {
          const handler = (msg: any) => {
            if (msg.type === 'names') {
              worker.off('message', handler)
              resolve(msg.data)
            } else if (msg.type === 'error') {
              worker.off('message', handler)
              reject(new Error(msg.error))
            }
          }
          worker.on('message', handler)
          worker.postMessage({ type: 'getNames' })
        },
      )
      console.log(
        `[perf] getNames: ${Date.now() - t0}ms (${result.length} names)`,
      )
      return reply(event, 'getNames', requestId, result)
    } catch (error) {
      console.error('[NameCountWorker] getNames error:', error)
      return reply(event, 'getNames', requestId, [])
    }
  }

  async getConnectCodes(event: IpcMainEvent, data?: RequestEnvelope<null>) {
    const { requestId } = unpackRequest<null>(data)
    if (!this.archive) return reply(event, 'getConnectCodes', requestId, [])

    try {
      const worker = this.ensureNameCountWorker()
      const t0 = Date.now()
      const result = await new Promise<{ name: string; total: number }[]>(
        (resolve, reject) => {
          const handler = (msg: any) => {
            if (msg.type === 'connectCodes') {
              worker.off('message', handler)
              resolve(msg.data)
            } else if (msg.type === 'error') {
              worker.off('message', handler)
              reject(new Error(msg.error))
            }
          }
          worker.on('message', handler)
          worker.postMessage({ type: 'getConnectCodes' })
        },
      )
      console.log(
        `[perf] getConnectCodes: ${Date.now() - t0}ms (${result.length} codes)`,
      )
      return reply(event, 'getConnectCodes', requestId, result)
    } catch (error) {
      console.error('[NameCountWorker] getConnectCodes error:', error)
      return reply(event, 'getConnectCodes', requestId, [])
    }
  }

  async getPath(
    event: IpcMainEvent,
    data: RequestEnvelope<
      | 'openFile'
      | 'openDirectory'
      | { type: 'openFile' | 'openDirectory'; defaultPath?: string }
    >,
  ) {
    const { requestId, payload } = unpackRequest<
      | 'openFile'
      | 'openDirectory'
      | { type: 'openFile' | 'openDirectory'; defaultPath?: string }
    >(data)
    const type =
      typeof payload === 'string' ? payload : payload?.type || 'openFile'
    const defaultPath =
      typeof payload === 'object' ? payload?.defaultPath : undefined
    const opts: dialog.OpenDialogOptions = { properties: [type] }
    if (defaultPath) {
      let resolved = defaultPath
      if (resolved.startsWith('~')) {
        resolved = path.join(os.homedir(), resolved.slice(1))
      }
      if (resolved.includes('%APPDATA%')) {
        resolved = resolved.replace('%APPDATA%', app.getPath('appData') || '')
      }
      if (fs.existsSync(resolved)) {
        opts.defaultPath = resolved
      }
    }
    const { canceled, filePaths } = await dialog.showOpenDialog(opts)
    if (canceled) return reply(event, 'getPath', requestId)
    return reply(event, 'getPath', requestId, filePaths[0])
  }

  async logPerfEvents(_event: IpcMainEvent, data: RequestEnvelope<any>) {
    try {
      const { payload } = unpackRequest<any>(data)
      const events = Array.isArray(payload) ? payload : payload?.events
      if (!Array.isArray(events) || events.length === 0) return
      await appendPerfEvents(events)
    } catch (error) {
      console.error('Perf log error:', error)
    }
  }

  async debugLog(_event: IpcMainEvent, data: RequestEnvelope<any>) {
    try {
      const { payload } = unpackRequest<any>(data)
      const lines = Array.isArray(payload) ? payload : []
      if (lines.length === 0) return
      const fsModule = await import('fs')
      const pathModule = await import('path')
      const logPath = pathModule.resolve(process.cwd(), 'logs', 'debug.log')
      const logDir = pathModule.dirname(logPath)
      if (!fsModule.existsSync(logDir))
        fsModule.mkdirSync(logDir, { recursive: true })
      fsModule.appendFileSync(logPath, `${lines.join('\n')}\n`)
    } catch (error) {
      console.error('Debug log error:', error)
    }
  }

  async logRendererError(event: IpcMainEvent, data: RequestEnvelope<any>) {
    const { requestId, payload } = unpackRequest<any>(data)
    logRenderer(payload)
    reply(event, 'rendererError', requestId)
  }

  // openCodeEditor, openCodeEditorForTemplate, _openCodeEditorWindow → CodeEditorManager

  initiateListeners() {
    ipcMain.on('getConfig', this.getConfig.bind(this))
    ipcMain.on('updateConfig', this.updateConfig.bind(this))
    ipcMain.on('setDefaultOutputPath', this.setDefaultOutputPath.bind(this))
    ipcMain.on('getDirectory', this.getDirectory.bind(this))
    ipcMain.on('getArchive', this.getArchive.bind(this))
    ipcMain.on('getFilterCount', this.getFilterCount.bind(this))
    ipcMain.on(
      'getImportStatus',
      this.importManager.getImportStatusHandler.bind(this.importManager),
    )
    ipcMain.on('createNewArchive', this.createNewArchive.bind(this))
    ipcMain.on('openExistingArchive', this.openExistingArchive.bind(this))
    ipcMain.on('newProject', this.newProject.bind(this))
    ipcMain.on('saveAsArchive', this.saveAsArchive.bind(this))
    ipcMain.on('getRecentProjects', this.getRecentProjects.bind(this))
    ipcMain.on('openRecentProject', this.openRecentProject.bind(this))
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
    ipcMain.on('closeArchive', this.closeArchive.bind(this))
    ipcMain.on('addFilter', this.addFilter.bind(this))
    ipcMain.on('saveEdgeRectangles', this.saveEdgeRectangles.bind(this))
    ipcMain.on('updateFilter', this.updateFilter.bind(this))
    ipcMain.on('reorderFilter', this.reorderFilter.bind(this))
    ipcMain.on('removeFilter', this.removeFilter.bind(this))
    ipcMain.on('saveCustomFilter', this.saveCustomFilter.bind(this))
    ipcMain.on('deleteCustomFilter', this.deleteCustomFilter.bind(this))
    ipcMain.on('getResults', this.getResults.bind(this))
    ipcMain.on('getAllResultIds', this.getAllResultIds.bind(this))
    ipcMain.on('getTableDuration', this.getTableDuration.bind(this))
    ipcMain.on('getNames', this.getNames.bind(this))
    ipcMain.on('getConnectCodes', this.getConnectCodes.bind(this))
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
      'runFilters',
      this.filterExecutor.runFilters.bind(this.filterExecutor),
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
    ipcMain.on('getPath', this.getPath.bind(this))
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
    ipcMain.on('playClips', this.videoManager.playClips.bind(this.videoManager))
    ipcMain.on('playClip', this.videoManager.playClip.bind(this.videoManager))
    ipcMain.on('stopPlayback', () => this.videoManager.stopPlayback())
    ipcMain.on(
      'recordClip',
      this.videoManager.recordClip.bind(this.videoManager),
    )
    ipcMain.on('removeGame', this.clipManager.removeGame.bind(this.clipManager))
    ipcMain.on(
      'removeResult',
      this.clipManager.removeResult.bind(this.clipManager),
    )
    ipcMain.on(
      'reorderClips',
      this.clipManager.reorderClips.bind(this.clipManager),
    )
    ipcMain.on('logPerfEvents', this.logPerfEvents.bind(this))
    ipcMain.on('debugLog', this.debugLog.bind(this))
    ipcMain.on('openFolder', (_event: IpcMainEvent, folderPath: string) => {
      if (!folderPath) return
      if (!fs.existsSync(folderPath)) {
        console.error('openFolder: path does not exist:', folderPath)
        return
      }
      shell.openPath(folderPath).then((err) => {
        if (err) console.error('shell.openPath failed:', err)
      })
    })
    ipcMain.on(
      'openDolphinFolder',
      (event: IpcMainEvent, data: RequestEnvelope<string>) => {
        const { requestId, payload: rawPath } = unpackRequest<string>(data)
        if (!rawPath) {
          return reply(event, 'openDolphinFolder', requestId, {
            found: false,
          })
        }
        let resolved = rawPath
        if (resolved.startsWith('~')) {
          resolved = path.join(os.homedir(), resolved.slice(1))
        }
        if (resolved.includes('%APPDATA%')) {
          resolved = resolved.replace('%APPDATA%', app.getPath('appData') || '')
        }
        if (!fs.existsSync(resolved)) {
          return reply(event, 'openDolphinFolder', requestId, {
            found: false,
          })
        }
        shell.openPath(resolved).then((err) => {
          if (err) console.error('shell.openPath failed:', err)
        })
        return reply(event, 'openDolphinFolder', requestId, { found: true })
      },
    )
    ipcMain.on('getLogsPath', (event: IpcMainEvent) => {
      event.reply('logsPath', getLogPath())
    })
    ipcMain.on(
      'exportLogs',
      async (event: IpcMainEvent, data: RequestEnvelope<null>) => {
        const { requestId } = unpackRequest<null>(data)
        try {
          // eslint-disable-next-line global-require
          const JSZip = require('jszip')
          const logsDir = getLogPath()
          const zip = new JSZip()
          try {
            await fsPromises.access(logsDir)
            const files = await fsPromises.readdir(logsDir)
            for (const file of files) {
              const filePath = path.join(logsDir, file)
              const stat = await fsPromises.stat(filePath)
              if (stat.isFile()) {
                zip.file(file, await fsPromises.readFile(filePath))
              }
            }
          } catch (_) {
            // logs dir doesn't exist or is empty
          }
          const downloadsDir = app.getPath('downloads')
          const timestamp = new Date()
            .toISOString()
            .replace(/[:.]/g, '-')
            .slice(0, 19)
          const outPath = path.join(
            downloadsDir,
            `lm-clipper-logs-${timestamp}.zip`,
          )
          const buf = await zip.generateAsync({ type: 'nodebuffer' })
          await fsPromises.writeFile(outPath, buf)
          shell.showItemInFolder(outPath)
          return reply(event, 'exportLogs', requestId, { path: outPath })
        } catch (error) {
          console.error('Export logs error:', error)
          return reply(event, 'exportLogs', requestId, {
            error: error instanceof Error ? error.message : String(error),
          })
        }
      },
    )
    ipcMain.on('getAppVersion', (event: IpcMainEvent) => {
      event.reply('appVersion', app.getVersion())
    })
    ipcMain.on('resetConfig', (event: IpcMainEvent) => {
      const preserveKeys = [
        'recentProjects',
        'lastArchivePath',
        'ssbmIsoPath',
        'dolphinPath',
        'outputPath',
        'defaultProjectDirectory',
      ]
      const preserved: Record<string, any> = {}
      for (const key of preserveKeys) {
        if (this.config[key] !== undefined) preserved[key] = this.config[key]
      }
      this.config = { ...defaultConfig, ...preserved }
      this.saveConfig()
      event.reply('config', this.config)
    })
    // Full factory reset: wipe ALL settings AND paths (no preserved keys) back
    // to first-run defaults, then relaunch so the app comes up as a brand-new
    // user. Projects on disk are NOT deleted — only the config. A one-shot
    // backup of the pre-reset config is left next to it as a safety net.
    ipcMain.on('resetApp', () => {
      try {
        if (fs.existsSync(this.configPath)) {
          fs.copyFileSync(this.configPath, `${this.configPath}.bak`)
        }
      } catch (_) {
        // best-effort backup; never block the reset on it
      }
      closeDb()
      this.config = JSON.parse(JSON.stringify(defaultConfig))
      this.config.numFilterThreads = autoFilterThreads()
      this.config.dolphinPath = detectPlaybackDolphin() || ''
      this.config.ssbmIsoPath = detectMeleeIso() || ''
      this.saveConfig()
      this.setArchiveInternal(null)
      if (app.isPackaged) {
        // Production: a true process restart → comes up as a fresh install.
        app.relaunch()
        app.exit(0)
      } else {
        // Dev (electronmon): a full process relaunch doesn't reliably come back,
        // so reload the window into the fresh first-run state instead. Same
        // visible result — the renderer re-fetches the now-default config and a
        // null archive, landing on the new-user Start screen.
        this.mainWindow.webContents.reload()
      }
    })
    ipcMain.on('openExternal', (_event: IpcMainEvent, url: string) => {
      if (
        typeof url === 'string' &&
        (url.startsWith('https://') || url.startsWith('http://'))
      ) {
        shell.openExternal(url)
      }
    })
    ipcMain.on('rendererError', this.logRendererError.bind(this))
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
