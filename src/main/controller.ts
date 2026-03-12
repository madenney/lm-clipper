import {
  app,
  ipcMain,
  dialog,
  shell,
  IpcMainEvent,
  BrowserWindow,
} from 'electron'
import { spawn, ChildProcess } from 'child_process'
import { Worker } from 'worker_threads'
import crypto from 'crypto'
import os from 'os'
import path from 'path'
import fs, { promises as fsPromises } from 'fs'
import { shuffleArray } from '../lib'
import { config as defaultConfig } from '../constants/defaults'
import { characters } from '../constants/characters'
import { stages } from '../constants/stages'
import { filtersConfig } from '../constants/config'
import {
  ArchiveInterface,
  ClipInterface,
  FileInterface,
  ConfigInterface,
  FilterInterface,
  ShallowArchiveInterface,
  ShallowFilterInterface,
  ReplayInterface,
} from '../constants/types'
import Archive from '../models/Archive'
import Filter from '../models/Filter'
import slpToVideo, {
  VideoJobController,
  setFFMPEGPathOverride,
} from './slpToVideo'
import { resolveHtmlPath, updateEfbScale, createOutputDirectory } from './util'
import {
  getMetaData,
  createDB,
  getTableCount,
  deleteFilterRun,
  deleteFiles,
  deleteRowsByFilePaths,
  getFilePathsByIds,
  deleteRows,
} from './db'
import { closeDb, getDb } from './dbConnection'
import { appendPerfEvents } from './perfLogger'
import { logMain, logRenderer, getLogPath } from './logger'

type ClipPayload = {
  path?: string
  startFrame?: number
  endFrame?: number
  lastFrame?: number
}

type RequestEnvelope<T> = {
  requestId?: string
  payload?: T
}

type ImportStatus = {
  isImporting: boolean
  current: number
  total: number | null
  queueLength: number
}

const unpackRequest = <T>(
  data: unknown,
): { requestId?: string; payload: T } => {
  if (data && typeof data === 'object') {
    const record = data as { requestId?: string; payload?: T }
    if ('requestId' in record && 'payload' in record) {
      return { requestId: record.requestId, payload: record.payload as T }
    }
  }
  return { requestId: undefined, payload: data as T }
}

const reply = (
  event: IpcMainEvent,
  channel: string,
  requestId: string | undefined,
  payload?: unknown,
) => {
  if (requestId) {
    event.reply(channel, { requestId, payload })
  } else {
    event.reply(channel, payload)
  }
}

const resolveClipFrames = (payload: ClipPayload) => {
  const hasStart =
    typeof payload.startFrame === 'number' && payload.startFrame !== 0
  const hasEnd = typeof payload.endFrame === 'number' && payload.endFrame !== 0
  const startFrame = hasStart ? payload.startFrame : -123
  const endFrame = hasEnd
    ? payload.endFrame
    : typeof payload.lastFrame === 'number' && payload.lastFrame > 0
      ? payload.lastFrame
      : 99999
  return { startFrame, endFrame }
}

const buildShallowArchive = (
  archive: ArchiveInterface | null,
): ShallowArchiveInterface | null => {
  if (!archive) return null
  return {
    path: archive.path,
    name: archive.name,
    createdAt: archive.createdAt,
    files: archive.files || 0,
    filters: (archive.filters || []).map((filter) => ({
      id: filter.id,
      type: filter.type,
      label: filter.label,
      isProcessed: filter.isProcessed,
      params: filter.params,
      results: filter.results,
      ...(filter.resumable ? { resumable: true } : {}),
    })),
  }
}

function getDefaultProjectDir(): string {
  if (process.platform === 'linux') {
    const xdgData =
      process.env.XDG_DATA_HOME || path.resolve(os.homedir(), '.local', 'share')
    return path.resolve(xdgData, 'lm-clipper')
  }
  return path.resolve(app.getPath('documents'), 'LM Clipper')
}

const getWorkerExecArgv = () => {
  const mode = process.env.LM_CLIPPER_WORKER_TS_NODE
  if (!mode) return undefined
  if (mode === 'esm') return ['--loader', 'ts-node/esm']
  return ['-r', 'ts-node/register/transpile-only']
}

export default class Controller {
  mainWindow: BrowserWindow
  configDir: string
  configPath: string
  archive: ArchiveInterface | null
  config: ConfigInterface
  runningFilterControllers: Map<string, AbortController>
  runningFilterIndices: Set<number>
  filterCancelIds: Set<string>
  currentImportAbortController: AbortController | null
  importQueue: string[][]
  importInProgress: boolean
  currentCountWorker: Worker | null
  nameCountWorker: Worker | null
  countWorkerExecArgv?: string[]
  importStatus: ImportStatus
  activeVideoJob: VideoJobController | null
  activePlaybackProcess: ChildProcess | null
  playbackAborted: boolean
  activeTmpDirs: Set<string>
  codeEditorWindow: BrowserWindow | null
  codeEditorContext: {
    filterIndex: number
    filterId: string
  } | null
  private filterCompletionLock: Promise<void>

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
    this.runningFilterControllers = new Map()
    this.runningFilterIndices = new Set()
    this.filterCancelIds = new Set()
    this.currentImportAbortController = null
    this.importQueue = []
    this.importInProgress = false
    this.currentCountWorker = null
    this.nameCountWorker = null
    this.activeVideoJob = null
    this.activePlaybackProcess = null
    this.playbackAborted = false
    this.activeTmpDirs = new Set()
    this.codeEditorWindow = null
    this.codeEditorContext = null
    this.filterCompletionLock = Promise.resolve()
    this.countWorkerExecArgv = getWorkerExecArgv()
    this.importStatus = {
      isImporting: false,
      current: 0,
      total: null,
      queueLength: 0,
    }
  }

  cleanup() {
    // Kill active video job (Dolphin + ffmpeg processes)
    if (this.activeVideoJob) {
      this.activeVideoJob.cancel()
      this.activeVideoJob = null
    }

    // Kill playback Dolphin process
    this.playbackAborted = true
    if (this.activePlaybackProcess) {
      try {
        this.activePlaybackProcess.kill()
      } catch (_) {
        // empty
      }
      this.activePlaybackProcess = null
    }

    // Abort running filters (terminates worker threads)
    for (const controller of this.runningFilterControllers.values()) {
      controller.abort()
    }
    this.runningFilterControllers.clear()
    this.runningFilterIndices.clear()
    this.filterCancelIds.clear()

    // Abort running import (terminates import worker pool)
    this.importQueue = []
    if (this.currentImportAbortController) {
      this.currentImportAbortController.abort()
      this.currentImportAbortController = null
    }

    // Kill count worker
    this.stopCountWorker()

    // Kill name count worker
    this.stopNameCountWorker()

    // Clean up temp directories
    for (const dir of this.activeTmpDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch (_) {
        // empty
      }
    }
    this.activeTmpDirs.clear()

    // Close code editor window
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

  async getImportStatus(event: IpcMainEvent, data?: RequestEnvelope<null>) {
    const { requestId } = unpackRequest<null>(data)
    return reply(event, 'getImportStatus', requestId, this.importStatus)
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

  private setImportStatus(next: Partial<ImportStatus>) {
    this.importStatus = { ...this.importStatus, ...next }
    if (this.mainWindow?.isDestroyed?.()) return
    this.mainWindow.webContents.send('importStatus', this.importStatus)
  }

  private stopCountWorker() {
    if (!this.currentCountWorker) return
    const worker = this.currentCountWorker
    this.currentCountWorker = null
    worker.terminate().catch(() => {})
  }

  private startCountWorker(filePaths: string[]) {
    this.stopCountWorker()
    if (!filePaths || filePaths.length === 0) return
    console.log('[CountWorker] starting, paths:', filePaths.length)
    const worker = new Worker(
      new URL('./ImportCountWorker.ts', import.meta.url),
      {
        ...(this.countWorkerExecArgv
          ? { execArgv: this.countWorkerExecArgv }
          : {}),
      },
    )
    this.currentCountWorker = worker
    console.log('[CountWorker] worker created, threadId:', worker.threadId)
    this.mainWindow.webContents.send('importingFileTotal', { total: null })
    this.setImportStatus({ total: null })

    worker.on(
      'message',
      (message: { type?: string; total?: number; error?: string }) => {
        console.log(
          '[CountWorker] message:',
          JSON.stringify(message),
          'still current:',
          worker === this.currentCountWorker,
        )
        if (worker !== this.currentCountWorker) return
        if (message?.type === 'done') {
          if (typeof message.total === 'number') {
            this.mainWindow.webContents.send('importingFileTotal', {
              total: message.total,
            })
            this.setImportStatus({ total: message.total })
          }
          this.stopCountWorker()
          return
        }
        if (message?.type === 'error') {
          console.error('[CountWorker] error:', message.error)
          this.stopCountWorker()
        }
      },
    )

    worker.on('error', (error) => {
      console.error('[CountWorker] worker error event:', error)
      if (worker !== this.currentCountWorker) return
      this.stopCountWorker()
    })

    worker.on('exit', (code) => {
      console.log(
        '[CountWorker] exit code:',
        code,
        'still current:',
        worker === this.currentCountWorker,
      )
      if (worker !== this.currentCountWorker) return
      this.currentCountWorker = null
    })

    worker.postMessage({ type: 'count', paths: filePaths })
    console.log('[CountWorker] message posted')
  }

  private enqueueImport(filePaths: string[]) {
    if (!filePaths || filePaths.length === 0) return
    this.importQueue.push(filePaths)
    this.setImportStatus({ queueLength: this.importQueue.length })
    this.processImportQueue()
  }

  private processImportQueue() {
    if (this.importInProgress) return
    const next = this.importQueue.shift()
    if (!next) return
    this.importInProgress = true
    this.setImportStatus({
      isImporting: true,
      current: 0,
      total: null,
      queueLength: this.importQueue.length,
    })
    this.runImport(next)
      .catch((error) => {
        console.error('Import failed:', error)
      })
      .finally(() => {
        this.importInProgress = false
        if (this.importQueue.length === 0) {
          this.setImportStatus({
            isImporting: false,
            current: 0,
            total: null,
            queueLength: 0,
          })
        }
        this.processImportQueue()
      })
  }

  private async runImport(filePaths: string[]) {
    if (!this.archive || !this.archive.addFiles) {
      this.currentImportAbortController = null
      this.stopCountWorker()
      this.setImportStatus({
        isImporting: false,
        current: 0,
        total: null,
        queueLength: this.importQueue.length,
      })
      this.mainWindow.webContents.send('importingFileUpdate', {
        finished: true,
        cancelled: true,
      })
      return
    }

    const fileCountBefore = this.archive.files || 0
    const detectDuplicates = this.config.detectDuplicatesOnImport !== false
    const maxWorkers = Math.max(1, this.config.numFilterThreads || 1)
    const importAbortController = new AbortController()
    this.currentImportAbortController = importAbortController
    this.startCountWorker(filePaths)
    this.mainWindow.webContents.send('importingFileUpdate', {
      current: 0,
      total: 0,
    })

    const result = await this.archive.addFiles!(
      filePaths,
      ({ current, total }) => {
        this.mainWindow.webContents.send('importingFileUpdate', {
          total,
          current,
        })
        if (typeof current === 'number') {
          this.setImportStatus({ current })
        }
      },
      {
        detectDuplicates,
        abortSignal: importAbortController.signal,
        maxWorkers,
      },
    )
    const { terminated, failed } = result

    if (this.currentImportAbortController === importAbortController) {
      this.currentImportAbortController = null
    }
    this.stopCountWorker()

    if (failed > 0) {
      console.log(`Import finished with ${failed} failed file(s)`)
    }

    // Refresh archive from DB to get the real file count
    try {
      const metadata = await getMetaData(this.archive.path)
      this.archive = new Archive(metadata)
    } catch (error) {
      console.error('Error refreshing archive after import:', error)
    }

    // First import (0 → N files): auto-run the game filter
    if (
      fileCountBefore === 0 &&
      !terminated &&
      this.archive &&
      this.archive.files > 0
    ) {
      const gameFilter = this.archive.filters.find((f) => f.type === 'files')
      if (gameFilter) {
        const filter = new Filter(gameFilter)
        const numThreads = this.config.numFilterThreads || 1
        await filter.run3(this.archive.path, 'files', numThreads, () => {})
        try {
          const metadata = await getMetaData(this.archive.path)
          this.archive = new Archive(metadata)
        } catch (error) {
          console.log(
            'Error refreshing archive after auto-run game filter:',
            error,
          )
        }
      }
    }

    if (this.importQueue.length === 0) {
      this.setImportStatus({
        isImporting: false,
        current: 0,
        total: null,
        queueLength: 0,
      })
    }
    this.mainWindow.webContents.send('importingFileUpdate', {
      finished: true,
      cancelled: terminated,
      failed,
      archive: buildShallowArchive(this.archive),
    })
  }

  async addFilesManual(event: IpcMainEvent, data?: RequestEnvelope<null>) {
    const { requestId } = unpackRequest<null>(data)
    if (!this.archive) {
      try {
        await this.autoCreateUntitledProject()
      } catch (error) {
        console.error('Error auto-creating project for import:', error)
        return reply(event, 'addFilesManual', requestId, {
          error: 'Failed to create project',
        })
      }
    }
    if (!this.archive || !this.archive.addFiles || !this.archive.shallowCopy) {
      return reply(event, 'addFilesManual', requestId, {
        error: 'archive undefined',
      })
    }

    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: ['openFile', 'openDirectory', 'multiSelections'],
      filters: [{ name: 'slp files', extensions: ['slp'] }],
    })
    if (canceled || !filePaths || filePaths.length === 0) {
      return reply(
        event,
        'addFilesManual',
        requestId,
        buildShallowArchive(this.archive),
      )
    }

    reply(event, 'addFilesManual', requestId, buildShallowArchive(this.archive))
    this.enqueueImport(filePaths)
    return undefined
  }

  async addDroppedFiles(event: IpcMainEvent, data: RequestEnvelope<string[]>) {
    const { requestId, payload } = unpackRequest<string[]>(data)
    if (!this.archive) {
      try {
        await this.autoCreateUntitledProject()
      } catch (error) {
        console.error('Error auto-creating project for drop import:', error)
        return reply(event, 'addDroppedFiles', requestId, {
          error: 'Failed to create project',
        })
      }
    }
    if (!this.archive || !this.archive.addFiles || !this.archive.shallowCopy)
      return reply(event, 'addDroppedFiles', requestId, {
        error: 'archive undefined',
      })
    reply(
      event,
      'addDroppedFiles',
      requestId,
      buildShallowArchive(this.archive),
    )
    this.enqueueImport(payload || [])
    return undefined
  }

  private _abortImport() {
    this.importQueue = []
    this.stopCountWorker()
    if (this.currentImportAbortController) {
      this.currentImportAbortController.abort()
      this.currentImportAbortController = null
    }
    this.setImportStatus({
      isImporting: false,
      current: 0,
      total: null,
      queueLength: 0,
    })
  }

  async cancelImport(event: IpcMainEvent, data?: RequestEnvelope<null>) {
    const { requestId } = unpackRequest<null>(data)
    this._abortImport()
    return reply(event, 'cancelImport', requestId)
  }

  async stopImport(event: IpcMainEvent, data?: RequestEnvelope<null>) {
    const { requestId } = unpackRequest<null>(data)
    this._abortImport()
    return reply(event, 'stopImport', requestId)
  }

  async closeArchive(event: IpcMainEvent, data?: RequestEnvelope<null>) {
    const { requestId } = unpackRequest<null>(data)
    this.stopNameCountWorker()
    closeDb()
    this.archive = null
    this.config.lastArchivePath = null
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2))
    this.setImportStatus({
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

  removeGame(
    event: IpcMainEvent,
    data: RequestEnvelope<{ fileIds: number[] }>,
  ) {
    const { requestId, payload } = unpackRequest<{ fileIds: number[] }>(data)
    if (!this.archive || !payload?.fileIds?.length) {
      return reply(event, 'removeGame', requestId, { error: 'invalid request' })
    }
    try {
      // Look up file paths before deleting so we can cascade
      const filePaths = getFilePathsByIds(this.archive.path, payload.fileIds)
      deleteFiles(this.archive.path, payload.fileIds)
      this.archive.files = getTableCount(this.archive.path, 'files')

      // Cascade: remove derived rows from all filter tables by file path
      if (filePaths.length > 0) {
        for (const f of this.archive.filters) {
          const cascaded = deleteRowsByFilePaths(
            this.archive.path,
            f.id,
            filePaths,
          )
          if (cascaded > 0) {
            f.results = getTableCount(this.archive.path, f.id)
          }
        }
      }

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

  removeResult(
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
      const filter = this.archive.filters.find((f) => f.id === payload.filterId)

      // If this is the game filter, also delete from the files table + cascade
      if (filter?.type === 'files') {
        const db = getDb(this.archive.path)
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
          deleteFiles(this.archive.path, fileIds)
          this.archive.files = getTableCount(this.archive.path, 'files')
        }
        // Cascade: remove derived rows from downstream filters by file path
        if (filePaths.length > 0) {
          for (const f of this.archive.filters) {
            if (f.id === payload.filterId) continue
            const cascaded = deleteRowsByFilePaths(
              this.archive.path,
              f.id,
              filePaths,
            )
            if (cascaded > 0) {
              f.results = getTableCount(this.archive.path, f.id)
            }
          }
        }
      }

      deleteRows(this.archive.path, payload.filterId, payload.rowIds)
      if (filter) {
        filter.results = getTableCount(this.archive.path, payload.filterId)
      }
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

  private broadcastRunningFilters() {
    if (this.mainWindow?.isDestroyed?.()) return
    this.mainWindow.webContents.send('currentlyRunningFilter', {
      running: Array.from(this.runningFilterIndices),
    })
  }

  private async _executeFilter(
    event: IpcMainEvent,
    requestId: string | undefined,
    replyChannel: string,
    filterId: string,
    resume: boolean,
  ) {
    if (!this.archive) {
      return reply(event, replyChannel, requestId, {
        error: 'archive undefined',
      })
    }

    const filterJSON = this.archive.filters.find(
      (filter) => filter.id === filterId,
    )
    if (!filterJSON) {
      return reply(event, replyChannel, requestId, {
        error: `no filter with id: '${filterId}' found`,
      })
    }

    const filterIndex = this.archive.filters.indexOf(filterJSON)
    const filter = new Filter(filterJSON)
    if (!filter.run3) {
      return reply(event, replyChannel, requestId, {
        error: `filter creation error: '${filterId}'`,
      })
    }

    const prevResultsTableId =
      filterIndex === 0 ? 'files' : this.archive.filters[filterIndex - 1].id

    // If this filter is already running, abort it first
    const existingController = this.runningFilterControllers.get(filterId)
    if (existingController) {
      existingController.abort()
      this.runningFilterControllers.delete(filterId)
    }

    // Fresh run: delete any existing run record
    if (!resume) {
      deleteFilterRun(this.archive.path, filterId)
    }

    const abortController = new AbortController()
    this.runningFilterControllers.set(filterId, abortController)
    this.runningFilterIndices.add(filterIndex)
    this.broadcastRunningFilters()

    const numFilterThreads = this.config.numFilterThreads || 1

    const filterResult = await filter.run3(
      this.archive.path,
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
    }

    if (filterLogs && filterLogs.length > 0) {
      this.mainWindow.webContents.send('filterLogs', {
        filterId,
        filterLabel: filterJSON.label,
        logs: filterLogs,
      })
    }

    // Check if upstream filter is still running (before cleanup)
    let filterMessage = ''
    if (filterIndex > 0) {
      const prevFilterId = this.archive.filters[filterIndex - 1]?.id
      if (prevFilterId && this.runningFilterControllers.has(prevFilterId)) {
        try {
          const prevCount = getTableCount(this.archive.path, prevFilterId)
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
      deleteFilterRun(this.archive.path, filterId)
      if (this.archive.resetFiltersFrom) {
        await this.archive.resetFiltersFrom(filterIndex)
      }
      const metadata = await getMetaData(this.archive.path)
      this.archive = new Archive(metadata)
      this.broadcastRunningFilters()
      return reply(event, replyChannel, requestId, metadata)
    }

    // Stop or normal completion: keep results, mark processed
    this.filterCancelIds.delete(filterId)

    // Serialize concurrent filter completions to prevent race conditions
    this.filterCompletionLock = this.filterCompletionLock.then(async () => {
      try {
        // Re-read archive from DB since another filter may have finished concurrently
        const freshMetadata = await getMetaData(this.archive!.path)
        this.archive = new Archive(freshMetadata)

        // Find the filter again in the refreshed archive and mark it processed
        const refreshedFilter = this.archive.filters.find(
          (f) => f.id === filterId,
        )
        if (refreshedFilter) {
          refreshedFilter.isProcessed = true
        }

        // Reset downstream filters that are NOT currently running
        const refreshedIndex = this.archive.filters.findIndex(
          (f) => f.id === filterId,
        )
        if (
          refreshedIndex >= 0 &&
          refreshedIndex + 1 < this.archive.filters.length
        ) {
          const downstream = this.archive.filters.slice(refreshedIndex + 1)
          for (const df of downstream) {
            if (!this.runningFilterControllers.has(df.id)) {
              df.isProcessed = false
              df.results = 0
            }
          }
        }

        if (this.archive.saveMetaData) await this.archive.saveMetaData()

        const metadata = await getMetaData(this.archive.path)
        this.archive = new Archive(metadata)

        const replyData = filterMessage
          ? { ...metadata, filterMessage: { [filterId]: filterMessage } }
          : metadata
        // Reply first so UI has correct results before isRunning flips to false
        reply(event, replyChannel, requestId, replyData)
        this.broadcastRunningFilters()
      } catch (error) {
        console.error('Error finalizing filter run:', error)
        try {
          const metadata = await getMetaData(this.archive!.path)
          this.archive = new Archive(metadata)
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
    if (!this.archive || !filterId) {
      return reply(event, 'dismissFilterResume', requestId, {
        error: 'archive undefined',
      })
    }

    // Delete the run record (keep partial results)
    deleteFilterRun(this.archive.path, filterId)

    // Refresh archive
    const metadata = await getMetaData(this.archive.path)
    this.archive = new Archive(metadata)
    return reply(event, 'dismissFilterResume', requestId, metadata)
  }

  async runFilters(event: IpcMainEvent, data?: RequestEnvelope<null>) {
    const { requestId } = unpackRequest<null>(data)
    if (!this.archive || !this.archive.shallowCopy) {
      return reply(event, 'runFilters', requestId, {
        error: 'archive undefined',
      })
    }

    const numFilterThreads = this.config.numFilterThreads || 1
    const batchAbort = new AbortController()

    let prevResultsTableId = 'files'
    for (let i = 0; i < this.archive.filters.length; i += 1) {
      const filterJSON = this.archive.filters[i]
      const filter = new Filter(filterJSON)

      this.runningFilterControllers.set(filterJSON.id, batchAbort)
      this.runningFilterIndices.add(i)
      this.broadcastRunningFilters()

      const filterResult = await filter.run3(
        this.archive.path,
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

      this.runningFilterControllers.delete(filterJSON.id)
      this.runningFilterIndices.delete(i)
      this.broadcastRunningFilters()

      if (terminated || batchAbort.signal.aborted) {
        if (this.archive.resetFiltersFrom) {
          await this.archive.resetFiltersFrom(i)
        }
        break
      }

      filterJSON.isProcessed = true
      filterJSON.results = 0
      prevResultsTableId = filterJSON.id
    }

    if (this.archive.saveMetaData) await this.archive.saveMetaData()

    const metadata = await getMetaData(this.archive.path)
    this.archive = new Archive(metadata)

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
      if (this.archive) {
        const filterIndex = this.archive.filters.findIndex(
          (f) => f.id === filterId,
        )
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

  async getPath(
    event: IpcMainEvent,
    data: RequestEnvelope<'openFile' | 'openDirectory'>,
  ) {
    const { requestId, payload } = unpackRequest<'openFile' | 'openDirectory'>(
      data,
    )
    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: [payload || 'openFile'],
    })
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

  async playClips(
    event: IpcMainEvent,
    data: RequestEnvelope<{ filterId: string; selectedIds: string[] }>,
  ) {
    const { payload } = unpackRequest<{
      filterId: string
      selectedIds: string[]
    }>(data)
    if (!this.archive || !payload?.selectedIds?.length) return

    const numericIds = payload.selectedIds
      .map((id) => parseInt(id, 10))
      .filter((n) => !Number.isNaN(n))
    if (numericIds.length === 0) return

    const items = await this.archive.getItemsByIds(payload.filterId, numericIds)
    if (!items || items.length === 0) return

    this.playbackAborted = false
    this.mainWindow.webContents.send('playbackStarted')

    for (const item of items) {
      if (this.playbackAborted) break
      if (!('path' in item) || !item.path) continue
      const clipPayload: ClipPayload = {
        path: item.path as string,
        startFrame:
          'startFrame' in item ? (item.startFrame as number) : undefined,
        endFrame: 'endFrame' in item ? (item.endFrame as number) : undefined,
        lastFrame: 'lastFrame' in item ? (item.lastFrame as number) : undefined,
      }
      await this.playClipAsync(clipPayload)
    }

    this.mainWindow.webContents.send('playbackDone')
  }

  stopPlayback() {
    this.playbackAborted = true
    if (this.activePlaybackProcess) {
      try {
        this.activePlaybackProcess.kill()
      } catch (_) {
        // empty
      }
    }
  }

  private async playClipAsync(
    payload: ClipPayload,
    reportError?: (_msg: string) => void,
  ): Promise<void> {
    const { dolphinPath, ssbmIsoPath } = this.config
    if (!dolphinPath || !ssbmIsoPath) {
      reportError?.('Error: dolphinPath or ssbmIsoPath not set.')
      return
    }

    try {
      await fsPromises.access(dolphinPath)
    } catch {
      reportError?.(`Error: Could not open Dolphin from path ${dolphinPath}. `)
      logMain('playClipAsync: Dolphin not found', { dolphinPath })
      return
    }

    try {
      await fsPromises.access(ssbmIsoPath)
    } catch {
      reportError?.(`Error: Could not access ISO from path ${ssbmIsoPath}. `)
      logMain('playClipAsync: ISO not found', { ssbmIsoPath })
      return
    }

    try {
      await fsPromises.access(payload.path)
    } catch {
      reportError?.(`Error: Could not access replay ${payload.path}. `)
      logMain('playClipAsync: replay file not found', {
        path: payload.path,
      })
      return
    }

    const { startFrame, endFrame } = resolveClipFrames(payload)
    const { addStartFrames, addEndFrames, playbackResolution } = this.config
    const adjustedStart = startFrame - addStartFrames
    const adjustedEnd = endFrame + addEndFrames
    const dolphinConfig = {
      mode: 'normal',
      replay: payload.path,
      startFrame: adjustedStart,
      endFrame: adjustedEnd,
      isRealTimeMode: false,
      commandId: crypto.randomBytes(12).toString('hex'),
    }

    await updateEfbScale(dolphinPath, playbackResolution ?? 2)

    const tmpDir = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), 'lm-clipper-'),
    )
    this.activeTmpDirs.add(tmpDir)
    const filePath = path.resolve(tmpDir, 'dolphinConfig.json')
    await fsPromises.writeFile(filePath, JSON.stringify(dolphinConfig))

    const args = [
      '-i',
      filePath,
      '-b',
      '-e',
      path.resolve(ssbmIsoPath),
      '--cout',
    ]

    logMain('playClipAsync: spawning Dolphin', {
      dolphinPath: path.resolve(dolphinPath),
      args,
      configJson: dolphinConfig,
    })

    try {
      if (this.activePlaybackProcess) {
        try {
          this.activePlaybackProcess.kill()
        } catch (_) {
          // empty
        }
      }

      const dolphinProcess = spawn(path.resolve(dolphinPath), args)
      this.activePlaybackProcess = dolphinProcess

      let dolphinStderr = ''
      dolphinProcess.stderr.setEncoding('utf8')
      dolphinProcess.stderr.on('data', (chunk: string) => {
        dolphinStderr += chunk
      })

      dolphinProcess.on('error', (err) => {
        logMain('playClipAsync: Dolphin spawn error', err)
        reportError?.(
          `Error launching Dolphin: ${err.message}. Check ${getLogPath()}/main.log`,
        )
      })

      await new Promise<void>((resolve) => {
        let targetEndFrame: number = Infinity
        let staleTimer: ReturnType<typeof setTimeout> | null = null
        const stdoutLines: string[] = []
        let killedReason = ''
        const resetStaleTimer = () => {
          if (staleTimer) clearTimeout(staleTimer)
          staleTimer = setTimeout(() => {
            killedReason = 'stale timer (no CURRENT_FRAME for 1s)'
            dolphinProcess.kill()
          }, 1000)
        }

        dolphinProcess.stdout.setEncoding('utf8')
        dolphinProcess.stdout.on('data', (chunk: string) => {
          const lines = chunk.split('\r\n')
          lines.forEach((line: string) => {
            if (stdoutLines.length < 50 && line.trim()) {
              stdoutLines.push(line)
            }
            if (line.includes('[PLAYBACK_END_FRAME]')) {
              const match = /\[PLAYBACK_END_FRAME\] ([0-9]+)/.exec(line)
              if (match?.[1])
                targetEndFrame = Math.min(
                  targetEndFrame,
                  parseInt(match[1], 10),
                )
            } else if (line.includes('[GAME_END_FRAME]')) {
              const match = /\[GAME_END_FRAME\] ([0-9]+)/.exec(line)
              if (match?.[1])
                targetEndFrame = Math.min(
                  targetEndFrame,
                  parseInt(match[1], 10),
                )
            } else if (
              targetEndFrame !== Infinity &&
              line.includes(`[CURRENT_FRAME] ${targetEndFrame}`)
            ) {
              killedReason = `reached target end frame ${targetEndFrame}`
              dolphinProcess.kill()
            } else if (line.includes('[CURRENT_FRAME]')) {
              resetStaleTimer()
            }
          })
        })

        dolphinProcess.on('exit', (code, signal) => {
          logMain('playClipAsync: Dolphin exited', {
            code,
            signal,
            killedReason: killedReason || 'unknown',
            stdoutLines,
            stderr: dolphinStderr.slice(-2000),
          })
          if (code !== 0 && code !== null) {
            reportError?.(
              `Dolphin exited with code ${code}. Check ${getLogPath()}/main.log`,
            )
          }
          if (this.activePlaybackProcess === dolphinProcess) {
            this.activePlaybackProcess = null
          }
          if (staleTimer) clearTimeout(staleTimer)
          fsPromises.unlink(filePath).catch(() => {})
          fsPromises.rmdir(tmpDir).catch(() => {})
          this.activeTmpDirs.delete(tmpDir)
          resolve()
        })
      })
    } catch (err) {
      logMain('playClipAsync: spawn failed', err)
      reportError?.('Error: Failed to launch Dolphin.')
    }
  }

  async playClip(event: IpcMainEvent, data: RequestEnvelope<ClipPayload>) {
    const { requestId, payload } = unpackRequest<ClipPayload>(data)
    if (!payload?.path) {
      this.mainWindow.webContents.send('videoMsg', 'No clip selected.')
      return reply(event, 'playClip', requestId)
    }

    await this.playClipAsync(payload, (msg) => {
      this.mainWindow.webContents.send('videoMsg', msg)
    })

    return reply(event, 'playClip', requestId)
  }

  async recordClip(event: IpcMainEvent, data: RequestEnvelope<ClipPayload>) {
    const { requestId, payload } = unpackRequest<ClipPayload>(data)
    if (!payload?.path) {
      this.mainWindow.webContents.send('videoMsg', 'No clip selected.')
      return reply(event, 'recordClip', requestId)
    }

    const {
      numCPUs,
      dolphinPath,
      ssbmIsoPath,
      gameMusic,
      hideHud,
      hideTags,
      hideNames,
      fixedCamera,
      enableChants,
      bitrateKbps,
      resolution,
      outputPath,
      addStartFrames,
      addEndFrames,
      lastClipOffset,
      dolphinCutoff,
      disableScreenShake,
      noElectricSFX,
      noCrowdNoise,
      disableMagnifyingGlass,
      overlaySource,
    } = this.config

    const effectiveNumCPUs = numCPUs || 1

    try {
      await fsPromises.access(payload.path)
    } catch {
      this.mainWindow.webContents.send(
        'videoMsg',
        `Error: Replay file not found: ${payload.path}`,
      )
      return reply(event, 'recordClip', requestId)
    }

    try {
      await fsPromises.access(outputPath)
    } catch (err) {
      this.mainWindow.webContents.send(
        'videoMsg',
        `Error: Could not access given output path ${outputPath} `,
      )
      return reply(event, 'recordClip', requestId)
    }

    const outputDirectory = createOutputDirectory(outputPath)

    const config = {
      ...this.config,
      outputPath: outputDirectory,
      numProcesses: effectiveNumCPUs,
      dolphinPath: path.resolve(dolphinPath),
      ssbmIsoPath: path.resolve(ssbmIsoPath),
      gameMusicOn: gameMusic,
      hideHud,
      hideTags,
      hideNames,
      overlaySource,
      disableScreenShake,
      disableChants: !enableChants,
      noElectricSFX,
      noCrowdNoise,
      disableMagnifyingGlass,
      fixedCamera,
      bitrateKbps,
      resolution,
      dolphinCutoff,
    }

    const { startFrame, endFrame } = resolveClipFrames(payload)
    const adjustedStart = startFrame - addStartFrames
    const adjustedEnd = endFrame + addEndFrames
    const replay: ReplayInterface = {
      index: 0,
      path: payload.path,
      startFrame: adjustedStart < -123 ? -123 : adjustedStart,
      endFrame: adjustedEnd,
    }

    if (lastClipOffset) {
      replay.endFrame += lastClipOffset
    }

    const job = slpToVideo([replay], config, (msg: string) => {
      this.mainWindow.webContents.send('videoMsg', msg)
    })
    await job.promise

    return reply(event, 'recordClip', requestId)
  }

  async generateVideo(
    event: IpcMainEvent,
    data?: RequestEnvelope<{ filterId: string; selectedIds: string[] }>,
  ) {
    const { requestId, payload } = unpackRequest<{
      filterId: string
      selectedIds: string[]
    }>(data)
    if (!this.archive || !this.archive.getAllItems) {
      this.mainWindow.webContents.send('videoMsg', 'No archive loaded.')
      return reply(event, 'generateVideo', requestId)
    }

    const {
      numCPUs,
      dolphinPath,
      ssbmIsoPath,
      gameMusic,
      hideHud,
      hideTags,
      hideNames,
      fixedCamera,
      enableChants,
      bitrateKbps,
      resolution,
      outputPath,
      addStartFrames,
      addEndFrames,
      slice,
      shuffle,
      lastClipOffset,
      dolphinCutoff,
      disableScreenShake,
      noElectricSFX,
      noCrowdNoise,
      disableMagnifyingGlass,
      overlaySource,
    } = this.config

    const effectiveNumCPUs = numCPUs || 1

    // check if output directory exist
    try {
      await fsPromises.access(outputPath)
    } catch (err) {
      this.mainWindow.webContents.send(
        'videoMsg',
        `Error: Could not access given output path ${outputPath} `,
      )
      return reply(event, 'generateVideo', requestId)
    }

    const outputDirectory = createOutputDirectory(outputPath)

    const config = {
      ...this.config,
      outputPath: outputDirectory,
      numProcesses: effectiveNumCPUs,
      dolphinPath: path.resolve(dolphinPath),
      ssbmIsoPath: path.resolve(ssbmIsoPath),
      gameMusicOn: gameMusic,
      hideHud,
      hideTags,
      hideNames,
      overlaySource,
      disableScreenShake,
      disableChants: !enableChants,
      noElectricSFX,
      noCrowdNoise,
      disableMagnifyingGlass,
      fixedCamera,
      bitrateKbps,
      resolution,
      dolphinCutoff,
    }

    const metadata = await getMetaData(this.archive.path)
    this.archive = new Archive(metadata)

    const filterId = payload?.filterId || 'files'
    const selectedIds = payload?.selectedIds || []

    let finalResults: any[]
    if (selectedIds.length > 0) {
      const numericIds = selectedIds
        .map((id) => parseInt(id, 10))
        .filter((n) => !Number.isNaN(n))
      finalResults = await this.archive.getItemsByIds(filterId, numericIds)
    } else {
      finalResults = await this.archive.getAllItems(filterId)
    }

    if (!finalResults || finalResults.length === 0) {
      this.mainWindow.webContents.send('videoMsg', 'No clips to generate.')
      return reply(event, 'generateVideo', requestId)
    }

    if (shuffle) finalResults = shuffleArray(finalResults)
    if (slice) finalResults = finalResults.slice(0, slice)

    const replays: ReplayInterface[] = []
    finalResults.forEach(
      (result: ClipInterface | FileInterface, index: number) => {
        const hasStart =
          typeof result.startFrame === 'number' && result.startFrame !== 0
        const hasEnd =
          typeof result.endFrame === 'number' && result.endFrame !== 0
        const startFrame = hasStart ? result.startFrame : -123
        const endFrame = hasEnd
          ? result.endFrame
          : (result as FileInterface).lastFrame || 99999

        const adjustedStart = startFrame - addStartFrames
        const adjustedEnd = endFrame + addEndFrames

        // Extract metadata for filename pattern
        const p1 =
          ('comboer' in result && result.comboer) ||
          ('players' in result && result.players?.[0]) ||
          undefined
        const p2 =
          ('comboee' in result && result.comboee) ||
          ('players' in result && result.players?.[1]) ||
          undefined
        const stageInfo = stages[result.stage as keyof typeof stages] as
          | { shortName?: string; name?: string }
          | undefined
        const combo = 'combo' in result ? result.combo : undefined
        const startedAt = result.startedAt
          ? new Date(result.startedAt * 1000)
          : undefined

        replays.push({
          index,
          path: result.path,
          startFrame: adjustedStart < -123 ? -123 : adjustedStart,
          endFrame: adjustedEnd,
          meta: {
            character1: p1
              ? characters[p1.characterId]?.shortName ||
                characters[p1.characterId]?.name
              : undefined,
            character2: p2
              ? characters[p2.characterId]?.shortName ||
                characters[p2.characterId]?.name
              : undefined,
            player1:
              p1?.displayName || p1?.connectCode || p1?.nametag || undefined,
            player2:
              p2?.displayName || p2?.connectCode || p2?.nametag || undefined,
            stage: stageInfo?.shortName || stageInfo?.name || undefined,
            date: startedAt
              ? `${startedAt.getFullYear()}-${String(startedAt.getMonth() + 1).padStart(2, '0')}-${String(startedAt.getDate()).padStart(2, '0')}`
              : undefined,
            time: startedAt
              ? `${String(startedAt.getHours()).padStart(2, '0')}${String(startedAt.getMinutes()).padStart(2, '0')}`
              : undefined,
            didKill: combo?.didKill,
            damage:
              combo &&
              typeof combo.startPercent === 'number' &&
              typeof combo.endPercent === 'number'
                ? Math.round(combo.endPercent - combo.startPercent)
                : undefined,
            moves: combo?.moves?.length,
          },
        })
      },
    )
    if (lastClipOffset && replays.length > 0) {
      replays[replays.length - 1].endFrame += lastClipOffset
    }

    console.log('Replays: ', replays)
    console.log('Config: ', config)
    this.mainWindow.webContents.send(
      'videoOutputPath',
      config.outputPath.replace(/\/+$/, ''),
    )
    this.activeVideoJob = slpToVideo(replays, config, (msg: string) => {
      this.mainWindow.webContents.send('videoMsg', msg)
    })
    try {
      await this.activeVideoJob.promise
    } finally {
      this.activeVideoJob = null
      this.mainWindow.webContents.send('videoJobFinished')
    }
    return reply(event, 'generateVideo', requestId)
  }

  stopVideo(event: IpcMainEvent, data?: RequestEnvelope<null>) {
    const { requestId } = unpackRequest<null>(data)
    if (this.activeVideoJob) {
      this.activeVideoJob.stop()
    }
    return reply(event, 'stopVideo', requestId)
  }

  cancelVideo(event: IpcMainEvent, data?: RequestEnvelope<null>) {
    const { requestId } = unpackRequest<null>(data)
    if (this.activeVideoJob) {
      this.activeVideoJob.cancel()
    }
    return reply(event, 'cancelVideo', requestId)
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

    editorWindow.on('closed', () => {
      ipcMain.removeListener('code-editor-save', onSave)
      ipcMain.removeListener('code-editor-save-template', onSaveTemplate)
      ipcMain.removeListener('code-editor-delete-template', onDeleteTemplate)
      ipcMain.removeListener('code-editor-test-run', onTestRun)
      ipcMain.removeListener('code-editor-close', onClose)
      this.codeEditorWindow = null
      this.codeEditorContext = null
    })

    editorWindow.loadURL(resolveHtmlPath('codeEditor.html'))
  }

  initiateListeners() {
    ipcMain.on('getConfig', this.getConfig.bind(this))
    ipcMain.on('updateConfig', this.updateConfig.bind(this))
    ipcMain.on('getDirectory', this.getDirectory.bind(this))
    ipcMain.on('getArchive', this.getArchive.bind(this))
    ipcMain.on('getImportStatus', this.getImportStatus.bind(this))
    ipcMain.on('createNewArchive', this.createNewArchive.bind(this))
    ipcMain.on('openExistingArchive', this.openExistingArchive.bind(this))
    ipcMain.on('newProject', this.newProject.bind(this))
    ipcMain.on('saveAsArchive', this.saveAsArchive.bind(this))
    ipcMain.on('getRecentProjects', this.getRecentProjects.bind(this))
    ipcMain.on('openRecentProject', this.openRecentProject.bind(this))
    ipcMain.on('addFilesManual', this.addFilesManual.bind(this))
    ipcMain.on('addDroppedFiles', this.addDroppedFiles.bind(this))
    ipcMain.on('cancelImport', this.cancelImport.bind(this))
    ipcMain.on('stopImport', this.stopImport.bind(this))
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
    ipcMain.on('runFilter', this.runFilter.bind(this))
    ipcMain.on('resumeFilter', this.resumeFilter.bind(this))
    ipcMain.on('dismissFilterResume', this.dismissFilterResume.bind(this))
    ipcMain.on('runFilters', this.runFilters.bind(this))
    ipcMain.on('cancelRunningFilters', this.cancelRunningFilters.bind(this))
    ipcMain.on('stopRunningFilters', this.stopRunningFilters.bind(this))
    ipcMain.on('stopFilter', this.stopFilter.bind(this))
    ipcMain.on('cancelFilter', this.cancelFilter.bind(this))
    ipcMain.on('getPath', this.getPath.bind(this))
    ipcMain.on('generateVideo', this.generateVideo.bind(this))
    ipcMain.on('stopVideo', this.stopVideo.bind(this))
    ipcMain.on('cancelVideo', this.cancelVideo.bind(this))
    ipcMain.on('playClips', this.playClips.bind(this))
    ipcMain.on('playClip', this.playClip.bind(this))
    ipcMain.on('stopPlayback', () => this.stopPlayback())
    ipcMain.on('recordClip', this.recordClip.bind(this))
    ipcMain.on('removeGame', this.removeGame.bind(this))
    ipcMain.on('removeResult', this.removeResult.bind(this))
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
    ipcMain.on('testDolphin', this.testDolphin.bind(this))
    ipcMain.on('openCodeEditor', this.openCodeEditor.bind(this))
    ipcMain.on(
      'openCodeEditorForTemplate',
      this.openCodeEditorForTemplate.bind(this),
    )
  }

  async testDolphin() {
    const { dolphinPath, ssbmIsoPath } = this.config
    if (!dolphinPath || !ssbmIsoPath) {
      this.mainWindow.webContents.send(
        'videoMsg',
        'Error: Set Dolphin and ISO paths first.',
      )
      return
    }

    try {
      await fsPromises.access(dolphinPath)
    } catch {
      this.mainWindow.webContents.send(
        'videoMsg',
        `Error: Dolphin not found at ${dolphinPath}`,
      )
      return
    }

    try {
      await fsPromises.access(ssbmIsoPath)
    } catch {
      this.mainWindow.webContents.send(
        'videoMsg',
        `Error: ISO not found at ${ssbmIsoPath}`,
      )
      return
    }

    // Resolve test .slp from assets
    const RESOURCES_PATH = app.isPackaged
      ? path.join(process.resourcesPath, 'assets')
      : path.join(__dirname, '../../assets')
    const testSlp = path.join(RESOURCES_PATH, 'test.slp')

    try {
      await fsPromises.access(testSlp)
    } catch {
      this.mainWindow.webContents.send(
        'videoMsg',
        `Error: test.slp not found at ${testSlp}`,
      )
      return
    }

    const dolphinConfig = {
      mode: 'normal',
      replay: testSlp,
      startFrame: -123,
      endFrame: 3600,
      isRealTimeMode: true,
      commandId: crypto.randomBytes(12).toString('hex'),
    }

    const tmpDir = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), 'lm-clipper-test-'),
    )
    this.activeTmpDirs.add(tmpDir)
    const configFile = path.resolve(tmpDir, 'testDolphinConfig.json')
    await fsPromises.writeFile(configFile, JSON.stringify(dolphinConfig))

    this.mainWindow.webContents.send('videoMsg', 'Launching Dolphin test...')

    try {
      const dolphinProcess = spawn(path.resolve(dolphinPath), [
        '-i',
        configFile,
        '-b',
        '-e',
        path.resolve(ssbmIsoPath),
        '--cout',
      ])

      const logLines: string[] = []
      const addLog = (line: string) => {
        logLines.push(line)
        console.log('[Dolphin test]', line)
      }

      dolphinProcess.stdout?.on('data', (data: Buffer) => {
        data
          .toString()
          .split('\n')
          .forEach((l) => {
            if (l.trim()) addLog(`stdout: ${l.trim()}`)
          })
      })

      dolphinProcess.stderr?.on('data', (data: Buffer) => {
        data
          .toString()
          .split('\n')
          .forEach((l) => {
            if (l.trim()) addLog(`stderr: ${l.trim()}`)
          })
      })

      dolphinProcess.on('error', (err) => {
        addLog(`spawn error: ${err.message}`)
        this.mainWindow.webContents.send(
          'videoMsg',
          `Dolphin error: ${err.message}`,
        )
      })

      dolphinProcess.on('exit', (code) => {
        fsPromises.unlink(configFile).catch(() => {})
        fsPromises.rmdir(tmpDir).catch(() => {})
        this.activeTmpDirs.delete(tmpDir)
        const logPath = path.join(os.tmpdir(), 'lm-clipper-dolphin-test.log')
        const logContent = [
          `Dolphin test log - ${new Date().toISOString()}`,
          `Exit code: ${code}`,
          `Dolphin path: ${dolphinPath}`,
          `ISO path: ${ssbmIsoPath}`,
          `Test replay: ${testSlp}`,
          '',
          ...logLines,
        ].join('\n')
        fs.writeFileSync(logPath, logContent)

        if (code !== 0 && logLines.length > 0) {
          const lastErr = logLines[logLines.length - 1]
          this.mainWindow.webContents.send(
            'videoMsg',
            `Dolphin failed (code ${code}): ${lastErr} — Log: ${logPath}`,
          )
        } else if (code !== 0) {
          this.mainWindow.webContents.send(
            'videoMsg',
            `Dolphin exited with code ${code}. Log: ${logPath}`,
          )
        } else {
          this.mainWindow.webContents.send(
            'videoMsg',
            `Dolphin test finished. Log: ${logPath}`,
          )
          setTimeout(() => {
            this.mainWindow.webContents.send('videoMsg', '')
          }, 5000)
        }
      })
    } catch (err: any) {
      this.mainWindow.webContents.send(
        'videoMsg',
        `Failed to launch Dolphin: ${err.message}`,
      )
    }
  }
}
