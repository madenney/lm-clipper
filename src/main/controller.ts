import {
  app,
  ipcMain,
  dialog,
  shell,
  IpcMainEvent,
  BrowserWindow,
} from 'electron'
import { Worker } from 'worker_threads'
import os from 'os'
import path from 'path'
import fs, { promises as fsPromises } from 'fs'
import { getWorkerExecArgv } from '../lib'
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
import { resolveHtmlPath } from './util'
import {
  getMetaData,
  createDB,
  getTableCount,
  deleteFilterRun,
  deleteFiles,
  deleteRowsByFilePaths,
  getFilePathsByIds,
  deleteRows,
  updateSortOrder,
} from './db'
import { closeDb, getDb } from './dbConnection'
import { appendPerfEvents } from './perfLogger'
import { logMain, logRenderer, getLogPath } from './logger'
import {
  RequestEnvelope,
  unpackRequest,
  reply,
  buildShallowArchive,
} from './ipcUtils'
import ConsoleManager from './managers/ConsoleManager'
import ImportManager from './managers/ImportManager'
import FilterExecutor from './managers/FilterExecutor'
import VideoManager from './managers/VideoManager'

function getDefaultProjectDir(): string {
  if (process.platform === 'linux') {
    const xdgData =
      process.env.XDG_DATA_HOME || path.resolve(os.homedir(), '.local', 'share')
    return path.resolve(xdgData, 'lm-clipper')
  }
  return path.resolve(app.getPath('documents'), 'LM Clipper')
}

export default class Controller {
  mainWindow: BrowserWindow
  configDir: string
  configPath: string
  archive: ArchiveInterface | null
  config: ConfigInterface
  nameCountWorker: Worker | null
  codeEditorWindow: BrowserWindow | null
  codeEditorContext: {
    filterIndex: number
    filterId: string
  } | null
  private _cleanupCodeEditorListeners: (() => void) | null
  private countWorkerExecArgv?: string[]

  // Managers
  consoleManager: ConsoleManager
  importManager: ImportManager
  filterExecutor: FilterExecutor
  videoManager: VideoManager

  constructor(mainWindow: BrowserWindow) {
    this.mainWindow = mainWindow
    this.configDir = path.resolve(app.getPath('appData'), 'lm-clipper')
    if (!fs.existsSync(this.configDir)) fs.mkdirSync(this.configDir)
    this.configPath = path.resolve(this.configDir, 'lm-clipper.json')
    if (!fs.existsSync(this.configPath))
      fs.writeFileSync(this.configPath, JSON.stringify(defaultConfig, null, 2))

    const loadedConfig = JSON.parse(fs.readFileSync(this.configPath).toString())
    this.config = { ...defaultConfig, ...loadedConfig }
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
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2))
    if (this.config.ffmpegPath) {
      setFFMPEGPathOverride(this.config.ffmpegPath)
    }
    this.archive = null
    this.nameCountWorker = null
    this.codeEditorWindow = null
    this.codeEditorContext = null
    this._cleanupCodeEditorListeners = null
    this.countWorkerExecArgv = getWorkerExecArgv()

    // Initialize managers
    this.consoleManager = new ConsoleManager(mainWindow, {
      getActiveFilter: () => this.filterExecutor.activeFilter,
      getActiveVideoJob: () => this.videoManager.activeVideoJob,
      getActiveImportArchive: () => this.importManager.activeImportArchive,
      getImportStatus: () => this.importManager.importStatus,
    })

    this.importManager = new ImportManager(mainWindow, {
      getConfig: () => this.config,
      getConfigPath: () => this.configPath,
      getArchive: () => this.archive,
      setArchive: (a) => {
        this.archive = a
      },
      autoCreateUntitledProject: () => this.autoCreateUntitledProject(),
      consoleManager: this.consoleManager,
    })

    this.filterExecutor = new FilterExecutor(mainWindow, {
      getArchive: () => this.archive,
      setArchive: (a) => {
        this.archive = a
      },
      getConfig: () => this.config,
      consoleManager: this.consoleManager,
    })

    this.videoManager = new VideoManager(mainWindow, {
      getArchive: () => this.archive,
      setArchive: (a) => {
        this.archive = a
      },
      getConfig: () => this.config,
      consoleManager: this.consoleManager,
    })
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
    if (this._cleanupCodeEditorListeners) {
      this._cleanupCodeEditorListeners()
      this._cleanupCodeEditorListeners = null
    }
    if (this.codeEditorWindow && !this.codeEditorWindow.isDestroyed()) {
      this.codeEditorWindow.destroy()
      this.codeEditorWindow = null
      this.codeEditorContext = null
    }
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
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2))
  }

  private removeFromRecentProjects(projectPath: string) {
    if (!this.config.recentProjects) return
    this.config.recentProjects = this.config.recentProjects.filter(
      (p) => p.path !== projectPath,
    )
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2))
  }

  private getUntitledName(dir: string): string {
    let name = 'Untitled'
    let counter = 1
    while (fs.existsSync(path.resolve(dir, name))) {
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
    const newArchivePath = path.resolve(
      payload.location || getDefaultProjectDir(),
      `${payload.name ? payload.name : 'lm-clipper-default-db'}`,
    )

    await createDB(
      newArchivePath,
      payload.name || 'lm-clipper-default',
      this.config.includeDefaultFilters !== false,
    )
    const metadata = await getMetaData(newArchivePath)
    this.archive = new Archive(metadata)

    this.config.lastArchivePath = newArchivePath
    this.config.projectName = metadata.name
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2))
    this.addToRecentProjects(metadata.name, newArchivePath)

    return metadata
  }

  async initArchive() {
    if (!this.config.lastArchivePath) {
      this.archive = null
      return
    }

    if (fs.existsSync(this.config.lastArchivePath)) {
      console.log('Loading from existing DB')
      try {
        const metadata = await getMetaData(this.config.lastArchivePath)
        this.archive = new Archive(metadata)
        return
      } catch (e) {
        console.error('error fetching from last archive path')
      }
    }

    // Stale path — clear it
    console.log('Last archive path not found, clearing')
    this.config.lastArchivePath = null
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2))
    this.archive = null
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
        'LM Clipper',
      )
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2))
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
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2))
    return reply(event, 'updateConfig', requestId)
  }

  async getArchive(event: IpcMainEvent, data?: RequestEnvelope<null>) {
    const { requestId } = unpackRequest<null>(data)
    if (this.archive) {
      try {
        this.stopNameCountWorker()
        const metadata = await getMetaData(this.archive.path)
        this.archive = new Archive(metadata)
        reply(event, 'archive', requestId, metadata)
      } catch (error) {
        console.error('Error loading archive metadata:', error)
        this.archive = null
        this.config.lastArchivePath = null
        fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2))
        reply(event, 'archive', requestId)
      }
    } else {
      reply(event, 'archive', requestId)
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
    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      defaultPath: this.config.lastArchivePath
        ? this.config.lastArchivePath
        : '',
    })
    if (canceled) return reply(event, 'directory', requestId)
    return reply(event, 'directory', requestId, filePaths[0])
  }

  async openExistingArchive(event: IpcMainEvent, data?: RequestEnvelope<null>) {
    const { requestId } = unpackRequest<null>(data)
    try {
      const { canceled, filePaths } = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [{ name: 'SQLite3 Database', extensions: ['*'] }],
        defaultPath: this.config.lastArchivePath
          ? path.dirname(this.config.lastArchivePath)
          : undefined,
      })
      if (canceled) return reply(event, 'openExistingArchive', requestId)

      this.stopNameCountWorker()
      closeDb()
      try {
        const metadata = await getMetaData(filePaths[0])
        this.archive = new Archive(metadata)
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
        const derivedName = path.basename(filePaths[0])
        const db = getDb(filePaths[0])
        db.prepare('UPDATE metadata SET name = ?').run(derivedName)
        this.archive.name = derivedName
      }

      this.config.lastArchivePath = this.archive.path
      this.config.projectName = this.archive.name
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2))
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
    this.archive = null
    this.config.lastArchivePath = null
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2))
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
      logMain('newProject: starting')
      const defaultDir = this.config.lastArchivePath
        ? path.dirname(this.config.lastArchivePath)
        : getDefaultProjectDir()
      logMain('newProject: defaultDir', { defaultDir })
      if (!fs.existsSync(defaultDir))
        fs.mkdirSync(defaultDir, { recursive: true })

      const { canceled, filePath: newPath } = await dialog.showSaveDialog({
        title: 'New Project',
        defaultPath: path.resolve(defaultDir, 'New Project'),
        filters: [{ name: 'LM Clipper Project', extensions: ['*'] }],
      })
      if (canceled || !newPath) {
        return reply(event, 'newProject', requestId)
      }

      logMain('newProject: creating', { newPath })
      const name = path.basename(newPath)
      const location = path.dirname(newPath)
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

    const { canceled, filePath: newPath } = await dialog.showSaveDialog({
      title: 'Save Project As',
      defaultPath: path.resolve(
        path.dirname(this.archive.path),
        this.archive.name,
      ),
      filters: [{ name: 'LM Clipper Project', extensions: ['*'] }],
    })
    if (canceled || !newPath) {
      return reply(event, 'saveAsArchive', requestId)
    }

    try {
      const oldPath = this.archive.path
      this.stopNameCountWorker()
      closeDb()
      await fsPromises.copyFile(oldPath, newPath)

      // Update the stored path and name inside the DB
      const newName = path.basename(newPath)
      const db = getDb(newPath)
      db.prepare('UPDATE metadata SET path = ?, name = ?').run(newPath, newName)

      const metadata = await getMetaData(newPath)
      this.archive = new Archive(metadata)

      this.config.lastArchivePath = newPath
      this.config.projectName = newName
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2))
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
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2))
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
      this.archive = new Archive(metadata)
      if (!this.archive || !this.archive.shallowCopy) {
        throw new Error('Failed to load project')
      }
      // Fix legacy projects whose name is still "Untitled"
      if (/^Untitled(\s\d+)?$/.test(this.archive.name)) {
        const derivedName = path.basename(projectPath)
        const db = getDb(projectPath)
        db.prepare('UPDATE metadata SET name = ?').run(derivedName)
        this.archive.name = derivedName
      }

      this.config.lastArchivePath = projectPath
      this.config.projectName = this.archive.name
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2))
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

    await this.archive.addFilter(newFilterJSON)
    const metadata = await this.archive.shallowCopy()
    return reply(event, 'addFilter', requestId, metadata)
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

    if (payload) {
      const _t0 = Date.now()
      deleteFilterRun(this.archive.path, payload)
      console.log(`[removeFilter] deleteFilterRun took ${Date.now() - _t0}ms`)
      const _t1 = Date.now()
      await this.archive.deleteFilter(payload)
      console.log(`[removeFilter] deleteFilter took ${Date.now() - _t1}ms`)
    }
    const _t2 = Date.now()
    const metadata = await this.archive.shallowCopy()
    console.log(`[removeFilter] shallowCopy took ${Date.now() - _t2}ms`)
    return reply(event, 'removeFilter', requestId, metadata)
  }

  async removeGame(
    event: IpcMainEvent,
    data: RequestEnvelope<{ fileIds: number[] }>,
  ) {
    const { requestId, payload } = unpackRequest<{ fileIds: number[] }>(data)
    if (!this.archive || !payload?.fileIds?.length) {
      return reply(event, 'removeGame', requestId, { error: 'invalid request' })
    }
    try {
      const archivePath = this.archive.path
      // Look up file paths before deleting so we can cascade
      const filePaths = getFilePathsByIds(archivePath, payload.fileIds)
      deleteFiles(archivePath, payload.fileIds)

      // Cascade: remove derived rows from all filter tables by file path
      if (filePaths.length > 0) {
        for (const f of this.archive.filters) {
          deleteRowsByFilePaths(archivePath, f.id, filePaths)
        }
      }

      // Refresh archive from DB to get accurate state
      const metadata = await getMetaData(archivePath)
      this.archive = new Archive(metadata)

      const removed = payload.fileIds.length
      this.mainWindow.webContents.send(
        'archiveUpdated',
        buildShallowArchive(this.archive),
      )
      return reply(event, 'removeGame', requestId, { removed })
    } catch (error: any) {
      console.error('[removeGame] error:', error)
      return reply(event, 'removeGame', requestId, { error: error.message })
    }
  }

  async removeResult(
    event: IpcMainEvent,
    data: RequestEnvelope<{ filterId: string; rowIds: number[] }>,
  ) {
    const { requestId, payload } = unpackRequest<{
      filterId: string
      rowIds: number[]
    }>(data)
    if (!this.archive || !payload?.filterId || !payload?.rowIds?.length) {
      return reply(event, 'removeResult', requestId, {
        error: 'invalid request',
      })
    }
    try {
      const archivePath = this.archive.path
      const filter = this.archive.filters.find((f) => f.id === payload.filterId)

      // If this is the game filter, also delete from the files table + cascade
      if (filter?.type === 'files') {
        const db = getDb(archivePath)
        const placeholders = payload.rowIds.map(() => '?').join(',')
        const rows = db
          .prepare(
            `SELECT CAST(JSON_EXTRACT(JSON, '$.id') AS INTEGER) AS fileId, JSON_EXTRACT(JSON, '$.path') AS filePath FROM "${payload.filterId}" WHERE id IN (${placeholders})`,
          )
          .all(...payload.rowIds) as { fileId: number; filePath: string }[]
        const fileIds = rows.map((r) => r.fileId).filter((id) => id > 0)
        const filePaths = rows
          .map((r) => r.filePath)
          .filter((p) => p && p.length > 0)
        if (fileIds.length > 0) {
          deleteFiles(archivePath, fileIds)
        }
        // Cascade: remove derived rows from downstream filters by file path
        if (filePaths.length > 0) {
          for (const f of this.archive.filters) {
            if (f.id === payload.filterId) continue
            deleteRowsByFilePaths(archivePath, f.id, filePaths)
          }
        }
      }

      deleteRows(archivePath, payload.filterId, payload.rowIds)

      // Refresh archive from DB to get accurate state
      const metadata = await getMetaData(archivePath)
      this.archive = new Archive(metadata)

      this.mainWindow.webContents.send(
        'archiveUpdated',
        buildShallowArchive(this.archive),
      )
      return reply(event, 'removeResult', requestId, {
        removed: payload.rowIds.length,
      })
    } catch (error: any) {
      console.error('[removeResult] error:', error)
      return reply(event, 'removeResult', requestId, { error: error.message })
    }
  }

  reorderClips(
    event: IpcMainEvent,
    data: RequestEnvelope<{
      filterId: string
      updates: { id: number; sort_order: number }[]
    }>,
  ) {
    const { requestId, payload } = unpackRequest<{
      filterId: string
      updates: { id: number; sort_order: number }[]
    }>(data)
    if (!this.archive || !payload?.filterId || !payload?.updates?.length) {
      return reply(event, 'reorderClips', requestId, {
        error: 'invalid request',
      })
    }
    try {
      updateSortOrder(this.archive.path, payload.filterId, payload.updates)
      return reply(event, 'reorderClips', requestId, { success: true })
    } catch (error: any) {
      console.error('[reorderClips] error:', error)
      return reply(event, 'reorderClips', requestId, { error: error.message })
    }
  }

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
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2))
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
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2))
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

    if (this.archive.saveMetaData) await this.archive.saveMetaData()
    return reply(
      event,
      'reorderFilter',
      requestId,
      await this.archive.shallowCopy(),
    )
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
    this.archive.filters[filterIndex] = new Filter({
      ...newFilter,
      isProcessed: false,
      results: 0,
    })
    this.archive.filters.slice(filterIndex + 1).forEach((filter) => {
      filter.isProcessed = false
      filter.results = 0
    })
    if (this.archive.saveMetaData) await this.archive.saveMetaData()
    return reply(
      event,
      'updateFilter',
      requestId,
      await this.archive.shallowCopy(),
    )
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
      const items = await this.archive.getItems({
        filterId,
        numPerPage,
        currentPage,
        offset,
        limit,
        lite,
      })
      const total = getTableCount(this.archive.path, filterId)
      reply(event, 'getResults', requestId, { items, total })
    } catch (error) {
      console.error('Error fetching results:', error)
      reply(event, 'getResults', requestId, { items: [], total: 0 })
    }
  }

  getAllResultIds(
    event: IpcMainEvent,
    data: RequestEnvelope<{ filterId: string }>,
  ) {
    const { requestId, payload } = unpackRequest<{ filterId: string }>(data)
    if (!this.archive || !payload?.filterId) {
      return reply(event, 'getAllResultIds', requestId, [])
    }
    try {
      const ids = this.archive.getAllIds(payload.filterId)
      reply(event, 'getAllResultIds', requestId, ids)
    } catch (error) {
      console.error('Error fetching all IDs:', error)
      reply(event, 'getAllResultIds', requestId, [])
    }
  }

  getTableDuration(
    event: IpcMainEvent,
    data: RequestEnvelope<{ filterId: string }>,
  ) {
    const { requestId, payload } = unpackRequest<{ filterId: string }>(data)
    if (!this.archive || !payload?.filterId) {
      return reply(event, 'getTableDuration', requestId, 0)
    }
    try {
      const total = this.archive.getTableDuration(payload.filterId)
      reply(event, 'getTableDuration', requestId, total)
    } catch (error) {
      console.error('Error calculating table duration:', error)
      reply(event, 'getTableDuration', requestId, 0)
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

  openCodeEditor(
    _event: IpcMainEvent,
    data: RequestEnvelope<{
      filterIndex: number
      filter: ShallowFilterInterface
    }>,
  ) {
    const { payload } = unpackRequest<{
      filterIndex: number
      filter: ShallowFilterInterface
    }>(data)
    if (!payload) return

    const { filterIndex, filter } = payload
    // Collect upstream context: filter types and custom output fields
    const upstreamFields: { name: string; type: string; from: string }[] = []
    const upstreamTypes: string[] = []
    if (this.archive) {
      for (const f of this.archive.filters) {
        if (f.id === filter.id) break
        upstreamTypes.push(f.type)
        if (f.type === 'custom' && Array.isArray(f.params?.outputFields)) {
          for (const of2 of f.params.outputFields) {
            if (of2.name) {
              upstreamFields.push({
                name: of2.name,
                type: of2.type || 'any',
                from: f.label || 'Custom Code',
              })
            }
          }
        }
      }
    }
    const initData = {
      code: filter.params?.code || '',
      filterName: filter.label,
      filterId: filter.id,
      savedCustomFilters: this.config.savedCustomFilters || [],
      mode: 'filter' as const,
      customParams: filter.params?.customParams || [],
      outputFields: filter.params?.outputFields || [],
      upstreamFields,
      upstreamTypes,
    }

    this._openCodeEditorWindow(initData, { filterIndex, filterId: filter.id })
  }

  openCodeEditorForTemplate(
    _event: IpcMainEvent,
    data: RequestEnvelope<{ templateIndex: number }>,
  ) {
    const { payload } = unpackRequest<{ templateIndex: number }>(data)
    if (!payload) return
    const { templateIndex } = payload
    const tmpl = this.config.savedCustomFilters?.[templateIndex]
    if (!tmpl) return

    const initData = {
      code: tmpl.code,
      filterName: tmpl.name,
      filterId: '',
      savedCustomFilters: this.config.savedCustomFilters || [],
      mode: 'template' as const,
      templateIndex,
      customParams: tmpl.customParams || [],
    }

    this._openCodeEditorWindow(initData, null)
  }

  _openCodeEditorWindow(
    initData: {
      code: string
      filterName: string
      filterId: string
      savedCustomFilters: { name: string; code: string }[]
      mode: 'filter' | 'template'
      templateIndex?: number
      customParams?: { name: string; type: string; value: string }[]
      outputFields?: { name: string; type: string }[]
      upstreamFields?: { name: string; type: string; from: string }[]
      upstreamTypes?: string[]
    },
    filterContext: { filterIndex: number; filterId: string } | null,
  ) {
    const windowTitle =
      initData.mode === 'template'
        ? `LM Clipper Code Editor - ${initData.filterName}`
        : `LM Clipper Custom Code Editor - ${initData.filterName}`

    // Clean up any stale IPC listeners from a previous code editor session
    if (this._cleanupCodeEditorListeners) {
      this._cleanupCodeEditorListeners()
      this._cleanupCodeEditorListeners = null
    }

    // If window already open, focus it and send new init data
    if (this.codeEditorWindow && !this.codeEditorWindow.isDestroyed()) {
      this.codeEditorContext = filterContext
      this.codeEditorWindow.setTitle(windowTitle)
      this.codeEditorWindow.webContents.send('code-editor-init', initData)
      this.codeEditorWindow.focus()
      return
    }

    this.codeEditorContext = filterContext

    const preloadPath = app.isPackaged
      ? path.join(__dirname, 'preload.js')
      : path.join(__dirname, '../../.erb/dll/preload.js')

    this.codeEditorWindow = new BrowserWindow({
      title: windowTitle,
      width: 1100,
      height: 750,
      webPreferences: {
        preload: preloadPath,
        devTools: false,
      },
      autoHideMenuBar: true,
    })

    // Remove menu bar entirely
    this.codeEditorWindow.setMenu(null)

    const editorWindow = this.codeEditorWindow

    // Listen for ready signal before sending init data
    ipcMain.once('code-editor-ready', () => {
      if (editorWindow && !editorWindow.isDestroyed()) {
        editorWindow.webContents.send('code-editor-init', initData)
      }
    })

    // Listen for save (filter mode)
    const onSave = (
      _saveEvent: IpcMainEvent,
      saveData: {
        code: string
        filterId: string
        mode?: string
        templateIndex?: number
      },
    ) => {
      if (!saveData) return

      // Template mode: overwrite the template in config
      if (
        saveData.mode === 'template' &&
        typeof saveData.templateIndex === 'number'
      ) {
        const idx = saveData.templateIndex
        if (
          this.config.savedCustomFilters &&
          idx >= 0 &&
          idx < this.config.savedCustomFilters.length
        ) {
          this.config.savedCustomFilters[idx].code = saveData.code
          fs.writeFileSync(
            this.configPath,
            JSON.stringify(this.config, null, 2),
          )
          // Notify editor of updated templates
          if (editorWindow && !editorWindow.isDestroyed()) {
            editorWindow.webContents.send('code-editor-templates-updated', [
              ...this.config.savedCustomFilters,
            ])
          }
          // Notify main window
          this.mainWindow.webContents.send(
            'config-templates-updated',
            this.config.savedCustomFilters,
          )
        }
        return
      }

      // Filter mode
      if (!this.archive || !this.codeEditorContext) return
      const { filterIndex: idx, filterId } = this.codeEditorContext
      if (saveData.filterId !== filterId) return
      const existingFilter = this.archive.filters[idx]
      if (!existingFilter) return
      existingFilter.params = { ...existingFilter.params, code: saveData.code }

      // If the saved code matches a template, sync its customParams & outputFields
      const matchedTemplate = (this.config.savedCustomFilters || []).find(
        (t) => t.code.trim() === saveData.code.trim(),
      )
      if (matchedTemplate) {
        existingFilter.label = matchedTemplate.name
        if (matchedTemplate.customParams) {
          existingFilter.params.customParams = JSON.parse(
            JSON.stringify(matchedTemplate.customParams),
          )
        }
        if (matchedTemplate.outputFields) {
          existingFilter.params.outputFields = JSON.parse(
            JSON.stringify(matchedTemplate.outputFields),
          )
        }
      }
      existingFilter.isProcessed = false
      existingFilter.results = 0
      // Invalidate downstream filters
      this.archive.filters.slice(idx + 1).forEach((f) => {
        f.isProcessed = false
        f.results = 0
      })
      if (this.archive.saveMetaData) this.archive.saveMetaData()
      const shallow = buildShallowArchive(this.archive)
      console.log(
        '[code-editor-save] filter params:',
        JSON.stringify(existingFilter.params.customParams),
      )
      console.log(
        '[code-editor-save] matched template:',
        matchedTemplate?.name || 'none',
      )
      this.mainWindow.webContents.send('code-editor-saved', shallow)
    }
    ipcMain.on('code-editor-save', onSave)

    // Listen for template save
    const onSaveTemplate = (
      _e: IpcMainEvent,
      tmplData: {
        name: string
        code: string
        customParams?: { name: string; type: string; value: string }[]
        outputFields?: { name: string; type: string }[]
      },
    ) => {
      if (!tmplData?.name || !tmplData?.code) return
      if (!this.config.savedCustomFilters) this.config.savedCustomFilters = []
      const existing = this.config.savedCustomFilters.findIndex(
        (t) => t.name === tmplData.name,
      )
      const entry = {
        name: tmplData.name,
        code: tmplData.code,
        customParams: tmplData.customParams,
        outputFields: tmplData.outputFields,
      }
      if (existing >= 0) {
        this.config.savedCustomFilters[existing] = entry
      } else {
        this.config.savedCustomFilters.push(entry)
      }
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2))
      const templates = [...this.config.savedCustomFilters]
      if (editorWindow && !editorWindow.isDestroyed()) {
        editorWindow.webContents.send(
          'code-editor-templates-updated',
          templates,
        )
      }
      // Notify main window
      this.mainWindow.webContents.send('config-templates-updated', templates)
    }
    ipcMain.on('code-editor-save-template', onSaveTemplate)

    // Listen for template delete
    const onDeleteTemplate = (_e: IpcMainEvent, index: number) => {
      if (
        !this.config.savedCustomFilters ||
        typeof index !== 'number' ||
        index < 0 ||
        index >= this.config.savedCustomFilters.length
      )
        return
      this.config.savedCustomFilters.splice(index, 1)
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2))
      const templates = [...this.config.savedCustomFilters]
      if (editorWindow && !editorWindow.isDestroyed()) {
        editorWindow.webContents.send(
          'code-editor-templates-updated',
          templates,
        )
      }
      this.mainWindow.webContents.send('config-templates-updated', templates)
    }
    ipcMain.on('code-editor-delete-template', onDeleteTemplate)

    // Test run: execute code on a sample of clips from the previous filter
    const onTestRun = async (
      _e: IpcMainEvent,
      testData: { code: string; customParams?: any[]; sampleSize?: number },
    ) => {
      if (!this.archive || !this.codeEditorContext) {
        editorWindow?.webContents.send('code-editor-test-result', {
          error: 'No archive or filter context',
        })
        return
      }
      const { filterIndex } = this.codeEditorContext
      try {
        // Get clips from the previous filter (or files table)
        const prevFilterId =
          filterIndex > 0 ? this.archive.filters[filterIndex - 1].id : 'files'
        const sampleSize =
          testData.sampleSize && testData.sampleSize > 0
            ? testData.sampleSize
            : 5
        const items = await this.archive.getItems!({
          filterId: prevFilterId,
          limit: sampleSize,
          offset: 0,
        })
        if (!items || items.length === 0) {
          editorWindow?.webContents.send('code-editor-test-result', {
            error: 'No clips available from previous filter',
          })
          return
        }

        // Build merged params
        const params: any = { code: testData.code }
        const reserved = new Set(['code', 'maxFiles', 'customParams'])
        if (Array.isArray(testData.customParams)) {
          params.customParams = testData.customParams
          for (const cp of testData.customParams) {
            if (!cp.name || reserved.has(cp.name)) continue
            if (cp.type === 'int') {
              const n = parseInt(cp.value, 10)
              params[cp.name] = Number.isNaN(n) ? 0 : n
            } else if (cp.type === 'array') {
              params[cp.name] = (cp.value ?? '')
                .split(',')
                .map((s: string) => s.trim())
                .filter(Boolean)
            } else {
              params[cp.name] = cp.value ?? ''
            }
          }
        }

        // Capture console output
        const logs: string[] = []
        const fakeConsole = {
          log: (...args: any[]) => {
            logs.push(
              args
                .map((a) =>
                  typeof a === 'object'
                    ? JSON.stringify(a, null, 2)
                    : String(a),
                )
                .join(' '),
            )
          },
          warn: (...args: any[]) => {
            logs.push(
              `[warn] ${args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')}`,
            )
          },
          error: (...args: any[]) => {
            logs.push(
              `[error] ${args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')}`,
            )
          },
        }

        // eslint-disable-next-line no-new-func
        const userFn = new Function(
          'clips',
          'params',
          'SlippiGame',
          'console',
          testData.code,
        )
        // eslint-disable-next-line global-require
        const { SlippiGame } = require('@slippi/slippi-js')
        const result = userFn(items as any[], params, SlippiGame, fakeConsole)

        const outputClips = Array.isArray(result) ? result : []

        editorWindow?.webContents.send('code-editor-test-result', {
          logs,
          inputClips: items,
          outputClips: outputClips.slice(0, 20),
          inputCount: items.length,
          outputCount: outputClips.length,
        })
      } catch (err: any) {
        editorWindow?.webContents.send('code-editor-test-result', {
          error: err?.message || String(err),
        })
      }
    }
    ipcMain.on('code-editor-test-run', onTestRun)

    // Close editor via IPC from renderer
    const onClose = () => {
      if (editorWindow && !editorWindow.isDestroyed()) {
        editorWindow.close()
      }
    }
    ipcMain.on('code-editor-close', onClose)

    const cleanupListeners = () => {
      ipcMain.removeListener('code-editor-save', onSave)
      ipcMain.removeListener('code-editor-save-template', onSaveTemplate)
      ipcMain.removeListener('code-editor-delete-template', onDeleteTemplate)
      ipcMain.removeListener('code-editor-test-run', onTestRun)
      ipcMain.removeListener('code-editor-close', onClose)
    }
    this._cleanupCodeEditorListeners = cleanupListeners

    editorWindow.on('closed', () => {
      cleanupListeners()
      this._cleanupCodeEditorListeners = null
      this.codeEditorWindow = null
      this.codeEditorContext = null
    })

    editorWindow.loadURL(resolveHtmlPath('codeEditor.html'))
  }

  initiateListeners() {
    ipcMain.on('getConfig', this.getConfig.bind(this))
    ipcMain.on('updateConfig', this.updateConfig.bind(this))
    ipcMain.on('setDefaultOutputPath', this.setDefaultOutputPath.bind(this))
    ipcMain.on('getDirectory', this.getDirectory.bind(this))
    ipcMain.on('getArchive', this.getArchive.bind(this))
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
    ipcMain.on('removeGame', this.removeGame.bind(this))
    ipcMain.on('removeResult', this.removeResult.bind(this))
    ipcMain.on('reorderClips', this.reorderClips.bind(this))
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
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2))
      event.reply('config', this.config)
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
    ipcMain.on('openCodeEditor', this.openCodeEditor.bind(this))
    ipcMain.on(
      'openCodeEditorForTemplate',
      this.openCodeEditorForTemplate.bind(this),
    )
  }
}
