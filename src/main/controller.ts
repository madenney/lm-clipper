import { app, ipcMain, dialog, IpcMainEvent, BrowserWindow } from 'electron'
import { spawn, ChildProcess } from 'child_process'
import { Worker } from 'worker_threads'
import crypto from 'crypto'
import os from 'os'
import path from 'path'
import fs, { promises as fsPromises } from 'fs'
import { shuffleArray } from '../lib'
import { config as defaultConfig } from '../constants/defaults'
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
  RecentProject,
} from '../constants/types'
import Archive from '../models/Archive'
import Filter from '../models/Filter'
import slpToVideo, { VideoJobController } from './slpToVideo'
import { getMetaData, createDB, getTableCount } from './db'
import { closeDb, getDb } from './dbConnection'
import { appendPerfEvents } from './perfLogger'
import { logRenderer } from './logger'

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

const unpackRequest = <T>(data: unknown): { requestId?: string; payload: T } => {
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
  payload?: unknown
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
  const hasEnd =
    typeof payload.endFrame === 'number' && payload.endFrame !== 0
  const startFrame = hasStart ? payload.startFrame : -123
  const endFrame = hasEnd
    ? payload.endFrame
    : typeof payload.lastFrame === 'number' && payload.lastFrame > 0
    ? payload.lastFrame
    : 99999
  return { startFrame, endFrame }
}

const buildShallowArchive = (
  archive: ArchiveInterface | null
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
    })),
  }
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
  countWorkerExecArgv?: string[]
  importStatus: ImportStatus
  activeVideoJob: VideoJobController | null
  activePlaybackProcess: ChildProcess | null
  activeTmpDirs: Set<string>

  constructor(mainWindow: BrowserWindow) {
    this.mainWindow = mainWindow
    this.configDir = path.resolve(app.getPath('appData'), 'lm-clipper')
    if (!fs.existsSync(this.configDir)) fs.mkdirSync(this.configDir)
    this.configPath = path.resolve(this.configDir, 'lm-clipper.json')
    if (!fs.existsSync(this.configPath))
      fs.writeFileSync(this.configPath, JSON.stringify(defaultConfig, null, 2))

    const loadedConfig = JSON.parse(fs.readFileSync(this.configPath).toString())
    this.config = { ...defaultConfig, ...loadedConfig }
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
    this.archive = null
    this.runningFilterControllers = new Map()
    this.runningFilterIndices = new Set()
    this.filterCancelIds = new Set()
    this.currentImportAbortController = null
    this.importQueue = []
    this.importInProgress = false
    this.currentCountWorker = null
    this.activeVideoJob = null
    this.activePlaybackProcess = null
    this.activeTmpDirs = new Set()
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
    if (this.activePlaybackProcess) {
      try { this.activePlaybackProcess.kill() } catch (_) {}
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

    // Clean up temp directories
    for (const dir of this.activeTmpDirs) {
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch (_) {}
    }
    this.activeTmpDirs.clear()
  }

  private addToRecentProjects(name: string, projectPath: string) {
    if (!this.config.recentProjects) this.config.recentProjects = []
    this.config.recentProjects = this.config.recentProjects.filter(
      (p) => p.path !== projectPath
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
      (p) => p.path !== projectPath
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
    const docsDir = path.resolve(app.getPath('documents'), 'LM Clipper')
    if (!fs.existsSync(docsDir)) fs.mkdirSync(docsDir, { recursive: true })
    const name = this.getUntitledName(docsDir)
    const metadata = await this.createNewArchiveInternal({ name, location: docsDir })
    return metadata
  }

  private async createNewArchiveInternal(payload: { name?: string; location?: string }) {
    closeDb()
    const newArchivePath = path.resolve(
      payload.location || app.getPath('documents'),
      `${payload.name ? payload.name : 'lm-clipper-default-db'}`
    )

    await createDB(newArchivePath, payload.name || 'lm-clipper-default')
    const metadata = await getMetaData(newArchivePath)
    this.archive = new Archive(metadata)

    this.config.lastArchivePath = newArchivePath
    this.config.projectName = metadata.name
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2))
    this.addToRecentProjects(metadata.name, newArchivePath)

    return metadata
  }

  async initArchive(){
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
        console.log('error fetching from last archive path')
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
    }>
  ) {
    const { requestId, payload } = unpackRequest<{
      key: string
      value: string | number | boolean | null
    }>(data)
    if (!payload) {
      return reply(event, 'updateConfig', requestId)
    }
    this.config[payload.key] = payload.value
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2))
    return reply(event, 'updateConfig', requestId)
  }

  async getArchive(event: IpcMainEvent, data?: RequestEnvelope<null>) {
    const { requestId } = unpackRequest<null>(data)
    if (this.archive ) {
      try {
        const metadata = await getMetaData(this.archive.path)
        this.archive = new Archive(metadata)
        reply(event, 'archive', requestId, metadata)
      } catch (error) {
        console.log('Error loading archive metadata:', error)
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
    data: RequestEnvelope<{ name?: string; location?: string }>
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
        filters: [{ name: 'SQLite3 Database', extensions: [] }],
      })
      if (canceled) return reply(event, 'openExistingArchive', requestId)

      closeDb()
      try{
        const metadata = await getMetaData(filePaths[0]) 
        this.archive = new Archive(metadata)
      } catch(e){
        console.log("Error opening archive", e)
        return reply(event, 'openExistingArchive', requestId, {
          error: 'Failed to open given filepath',
        })
      }
      
      
      if (!this.archive || !this.archive.shallowCopy)
        throw new Error('Something went wrong :(')
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
    const worker = new Worker(new URL('./ImportCountWorker.ts', import.meta.url), {
      ...(this.countWorkerExecArgv ? { execArgv: this.countWorkerExecArgv } : {}),
    })
    this.currentCountWorker = worker
    this.mainWindow.webContents.send('importingFileTotal', { total: null })
    this.setImportStatus({ total: null })

    worker.on('message', (message: { type?: string; total?: number; error?: string }) => {
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
        console.log('Count worker error:', message.error)
        this.stopCountWorker()
      }
    })

    worker.on('error', (error) => {
      if (worker !== this.currentCountWorker) return
      console.log('Count worker error:', error)
      this.stopCountWorker()
    })

    worker.on('exit', (code) => {
      if (worker !== this.currentCountWorker) return
      if (code !== 0) {
        console.log(`Count worker exited with code ${code}`)
      }
      this.currentCountWorker = null
    })

    worker.postMessage({ type: 'count', paths: filePaths })
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
        console.log('Import failed:', error)
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
      }
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
      console.log('Error refreshing archive after import:', error)
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
        console.log('Error auto-creating project for import:', error)
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
      return reply(event, 'addFilesManual', requestId, buildShallowArchive(this.archive))
    }

    reply(event, 'addFilesManual', requestId, buildShallowArchive(this.archive))
    this.enqueueImport(filePaths)
    return undefined
  }


  async addDroppedFiles(
    event: IpcMainEvent,
    data: RequestEnvelope<string[]>
  ) {
    const { requestId, payload } = unpackRequest<string[]>(data)
    if(!this.archive){
      try {
        await this.autoCreateUntitledProject()
      } catch (error) {
        console.log('Error auto-creating project for drop import:', error)
        return reply(event, 'addDroppedFiles', requestId, {
          error: 'Failed to create project',
        })
      }
    }
    if (!this.archive || !this.archive.addFiles || !this.archive.shallowCopy)
      return reply(event, 'addDroppedFiles', requestId, {
        error: 'archive undefined',
      })
    reply(event, 'addDroppedFiles', requestId, buildShallowArchive(this.archive))
    this.enqueueImport(payload || [])
    return undefined
  }

  async cancelImport(event: IpcMainEvent, data?: RequestEnvelope<null>) {
    const { requestId } = unpackRequest<null>(data)
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
    return reply(event, 'cancelImport', requestId)
  }

  async stopImport(event: IpcMainEvent, data?: RequestEnvelope<null>) {
    const { requestId } = unpackRequest<null>(data)
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
    return reply(event, 'stopImport', requestId)
  }

  async closeArchive(event: IpcMainEvent, data?: RequestEnvelope<null>) {
    const { requestId } = unpackRequest<null>(data)
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
      const metadata = await this.autoCreateUntitledProject()
      return reply(event, 'newProject', requestId, metadata)
    } catch (error) {
      console.log('Error creating new project:', error)
      return reply(event, 'newProject', requestId, { error: true, info: error })
    }
  }

  async saveAsArchive(event: IpcMainEvent, data?: RequestEnvelope<null>) {
    const { requestId } = unpackRequest<null>(data)
    if (!this.archive) {
      return reply(event, 'saveAsArchive', requestId, { error: 'No project open' })
    }

    const { canceled, filePath: newPath } = await dialog.showSaveDialog({
      title: 'Save Project As',
      defaultPath: path.resolve(
        path.dirname(this.archive.path),
        this.archive.name
      ),
      filters: [{ name: 'LM Clipper Project', extensions: [] }],
    })
    if (canceled || !newPath) {
      return reply(event, 'saveAsArchive', requestId)
    }

    try {
      const oldPath = this.archive.path
      closeDb()
      await fsPromises.copyFile(oldPath, newPath)

      const metadata = await getMetaData(newPath)
      this.archive = new Archive(metadata)

      // Update the stored path inside the DB
      const db = getDb(newPath)
      db.prepare('UPDATE metadata SET path = ?').run(newPath)

      this.config.lastArchivePath = newPath
      this.config.projectName = metadata.name
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2))
      this.addToRecentProjects(metadata.name, newPath)

      const shallow = await this.archive.shallowCopy!()
      return reply(event, 'saveAsArchive', requestId, shallow)
    } catch (error) {
      console.log('Error saving project as:', error)
      return reply(event, 'saveAsArchive', requestId, { error: true, info: error })
    }
  }

  async getRecentProjects(event: IpcMainEvent, data?: RequestEnvelope<null>) {
    const { requestId } = unpackRequest<null>(data)
    const recents = (this.config.recentProjects || []).filter(
      (p) => fs.existsSync(p.path)
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
      closeDb()
      const metadata = await getMetaData(projectPath)
      this.archive = new Archive(metadata)
      if (!this.archive || !this.archive.shallowCopy) {
        throw new Error('Failed to load project')
      }
      this.config.lastArchivePath = projectPath
      this.config.projectName = this.archive.name
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2))
      this.addToRecentProjects(this.archive.name, projectPath)
      const shallow = await this.archive.shallowCopy()
      return reply(event, 'openRecentProject', requestId, shallow)
    } catch (error) {
      console.log('Error opening recent project:', error)
      return reply(event, 'openRecentProject', requestId, { error: true, info: error })
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
        console.log('Error creating default DB:', error)
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
    const template = filtersConfig.find((p) => p.id === payload)
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
    //this.archive.filters.push(new Filter(newFilterJSON))
    await this.archive.addFilter(newFilterJSON)
    const metadata = await this.archive.shallowCopy()
    return reply(event, 'addFilter', requestId, metadata)
  }

  async removeFilter(event: IpcMainEvent, data: RequestEnvelope<string>) {
    const { requestId, payload } = unpackRequest<string>(data)
    if (!this.archive || !this.archive.shallowCopy || !this.archive.deleteFilter){
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
      await this.archive.deleteFilter(payload)
    }
    return reply(event, 'removeFilter', requestId, await this.archive.shallowCopy())
  }

  async updateFilter(
    event: IpcMainEvent,
    data: RequestEnvelope<{
      filterIndex: number
      newFilter: ShallowFilterInterface
    }>
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
      await this.archive.shallowCopy()
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
    }>
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
      console.log('Error fetching results:', error)
      reply(event, 'getResults', requestId, { items: [], total: 0 })
    }
  }

  async getNames(event: IpcMainEvent, data?: RequestEnvelope<null>) {
    const { requestId } = unpackRequest<null>(data)
    if (!this.archive || !this.archive.getNames)
      return reply(event, 'getNames', requestId, [])
    const names = await this.archive.getNames()
    
    return reply(event, 'getNames', requestId, names)
  }

  private broadcastRunningFilters() {
    if (this.mainWindow?.isDestroyed?.()) return
    this.mainWindow.webContents.send('currentlyRunningFilter', {
      running: Array.from(this.runningFilterIndices),
    })
  }

  async runFilter(event: IpcMainEvent, data: RequestEnvelope<string>) {
    const { requestId, payload } = unpackRequest<string>(data)
    if (!this.archive) {
      return reply(event, 'runFilter', requestId, { error: 'archive undefined' })
    }

    const filterId = payload
    const filterJSON = this.archive.filters.find(
      (filter) => filter.id === filterId
    )
    if (!filterJSON) {
      return reply(event, 'runFilter', requestId, {
        error: `no filter with id: '${filterId}' found`,
      })
    }

    const filterIndex = this.archive.filters.indexOf(filterJSON)
    const filter = new Filter(filterJSON)
    if (!filter.run3) {
      return reply(event, 'runFilter', requestId, {
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

    const abortController = new AbortController()
    this.runningFilterControllers.set(filterId, abortController)
    this.runningFilterIndices.add(filterIndex)
    this.broadcastRunningFilters()

    const numFilterThreads = this.config.numFilterThreads || 1

    const terminated = await filter.run3(
      this.archive.path,
      prevResultsTableId,
      numFilterThreads,
      (eventUpdate: { current: number; total: number; newItemCount?: number }) => {
        const { total, current, newItemCount } = eventUpdate
        this.mainWindow.webContents.send('filterUpdate', {
          filterId,
          filterIndex,
          total,
          current,
          results: newItemCount,
        })
      },
      abortController.signal
    )

    // Check if upstream filter is still running (before cleanup)
    let filterMessage = ''
    if (filterIndex > 0) {
      const prevFilterId = this.archive.filters[filterIndex - 1]?.id
      if (prevFilterId && this.runningFilterControllers.has(prevFilterId)) {
        try {
          const prevCount = getTableCount(this.archive.path, prevFilterId)
          filterMessage = prevCount === 0
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
    this.broadcastRunningFilters()

    if (terminated && this.filterCancelIds.has(filterId)) {
      // Cancel: drop partial results, reset filter
      this.filterCancelIds.delete(filterId)
      if (this.archive.resetFiltersFrom) {
        await this.archive.resetFiltersFrom(filterIndex)
      }
      const metadata = await getMetaData(this.archive.path)
      this.archive = new Archive(metadata)
      return reply(event, 'runFilter', requestId, metadata)
    }

    // Stop or normal completion: keep results, mark processed
    this.filterCancelIds.delete(filterId)

    // Re-read archive from DB since another filter may have finished concurrently
    const freshMetadata = await getMetaData(this.archive.path)
    this.archive = new Archive(freshMetadata)

    // Find the filter again in the refreshed archive and mark it processed
    const refreshedFilter = this.archive.filters.find((f) => f.id === filterId)
    if (refreshedFilter) {
      refreshedFilter.isProcessed = true
      refreshedFilter.results = 0
    }

    // Reset downstream filters that are NOT currently running
    const refreshedIndex = this.archive.filters.findIndex((f) => f.id === filterId)
    if (refreshedIndex >= 0 && refreshedIndex + 1 < this.archive.filters.length) {
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
    return reply(event, 'runFilter', requestId, replyData)
  }

  async runFilters(event: IpcMainEvent, data?: RequestEnvelope<null>) {
    const { requestId } = unpackRequest<null>(data)
    if (!this.archive || !this.archive.shallowCopy) {
      return reply(event, 'runFilters', requestId, { error: 'archive undefined' })
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

      const terminated = await filter.run3(
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
        batchAbort.signal
      )

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

  async cancelRunningFilters(event: IpcMainEvent, data?: RequestEnvelope<null>) {
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
          (f) => f.id === filterId
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
    data: RequestEnvelope<'openFile' | 'openDirectory'>
  ) {
    const { requestId, payload } = unpackRequest<'openFile' | 'openDirectory'>(
      data
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
      console.log('Perf log error:', error)
    }
  }

  async debugLog(_event: IpcMainEvent, data: RequestEnvelope<any>) {
    try {
      const { payload } = unpackRequest<any>(data)
      const lines = Array.isArray(payload) ? payload : []
      if (lines.length === 0) return
      const fs = await import('fs')
      const path = await import('path')
      const logPath = path.resolve(process.cwd(), 'logs', 'debug.log')
      const logDir = path.dirname(logPath)
      if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true })
      fs.appendFileSync(logPath, lines.join('\n') + '\n')
    } catch (error) {
      console.log('Debug log error:', error)
    }
  }

  async logRendererError(event: IpcMainEvent, data: RequestEnvelope<any>) {
    const { requestId, payload } = unpackRequest<any>(data)
    logRenderer(payload)
    reply(event, 'rendererError', requestId)
  }

  async playClip(event: IpcMainEvent, data: RequestEnvelope<ClipPayload>) {
    const { requestId, payload } = unpackRequest<ClipPayload>(data)
    if (!payload?.path) {
      this.mainWindow.webContents.send('videoMsg', 'No clip selected.')
      return reply(event, 'playClip', requestId)
    }

    const { dolphinPath, ssbmIsoPath } = this.config
    if (!dolphinPath || !ssbmIsoPath) {
      this.mainWindow.webContents.send(
        'videoMsg',
        'Error: dolphinPath or ssbmIsoPath not set.'
      )
      return reply(event, 'playClip', requestId)
    }

    try {
      await fsPromises.access(dolphinPath)
    } catch (error) {
      this.mainWindow.webContents.send(
        'videoMsg',
        `Error: Could not open Dolphin from path ${dolphinPath}. `
      )
      return reply(event, 'playClip', requestId)
    }

    try {
      await fsPromises.access(ssbmIsoPath)
    } catch (error) {
      this.mainWindow.webContents.send(
        'videoMsg',
        `Error: Could not access ISO from path ${ssbmIsoPath}. `
      )
      return reply(event, 'playClip', requestId)
    }

    try {
      await fsPromises.access(payload.path)
    } catch (error) {
      this.mainWindow.webContents.send(
        'videoMsg',
        `Error: Could not access replay ${payload.path}. `
      )
      return reply(event, 'playClip', requestId)
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

    // Apply player resolution to Dolphin GFX settings
    const efbScale = playbackResolution ?? 2
    try {
      let gfxPath: string
      if (os.type() === 'Linux') {
        const appData = app.getPath('appData')
        gfxPath = path.join(appData, 'SlippiPlayback', 'Config', 'GFX.ini')
      } else {
        const dolphinDir = path.dirname(dolphinPath)
        gfxPath = path.join(dolphinDir, 'User', 'Config', 'GFX.ini')
      }
      const gfxContent = await fsPromises.readFile(gfxPath, 'utf8')
      const updatedContent = gfxContent.replace(
        /^EFBScale\s*=.*$/m,
        `EFBScale = ${efbScale}`
      )
      await fsPromises.writeFile(gfxPath, updatedContent)
    } catch {
      // GFX.ini not found or unreadable — continue with Dolphin defaults
    }

    const tmpDir = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), 'lm-clipper-')
    )
    this.activeTmpDirs.add(tmpDir)
    const filePath = path.resolve(tmpDir, 'dolphinConfig.json')
    await fsPromises.writeFile(filePath, JSON.stringify(dolphinConfig))

    const args = ['-i', filePath, '-b', '-e', path.resolve(ssbmIsoPath), '--cout']
    try {
      // Kill any previous playback process
      if (this.activePlaybackProcess) {
        try { this.activePlaybackProcess.kill() } catch (_) {}
      }

      const dolphinProcess = spawn(path.resolve(dolphinPath), args)
      this.activePlaybackProcess = dolphinProcess

      let targetEndFrame: string | number = Infinity
      let staleTimer: ReturnType<typeof setTimeout> | null = null
      const resetStaleTimer = () => {
        if (staleTimer) clearTimeout(staleTimer)
        staleTimer = setTimeout(() => {
          dolphinProcess.kill()
        }, 1000)
      }

      dolphinProcess.stdout.setEncoding('utf8')
      dolphinProcess.stdout.on('data', (chunk: string) => {
        const lines = chunk.split('\r\n')
        lines.forEach((line: string) => {
          if (line.includes('[PLAYBACK_END_FRAME]')) {
            const match = /\[PLAYBACK_END_FRAME\] ([0-9]*)/.exec(line)
            targetEndFrame = match && match[1] ? match[1] : Infinity
          } else if (line.includes('[GAME_END_FRAME]')) {
            dolphinProcess.kill()
          } else if (line.includes(`[CURRENT_FRAME] ${targetEndFrame}`)) {
            dolphinProcess.kill()
          } else if (line.includes('[CURRENT_FRAME]')) {
            resetStaleTimer()
          }
        })
      })

      dolphinProcess.on('exit', () => {
        if (this.activePlaybackProcess === dolphinProcess) {
          this.activePlaybackProcess = null
        }
        if (staleTimer) clearTimeout(staleTimer)
        fsPromises.unlink(filePath).catch(() => {})
        fsPromises.rmdir(tmpDir).catch(() => {})
        this.activeTmpDirs.delete(tmpDir)
      })
    } catch (error) {
      this.mainWindow.webContents.send(
        'videoMsg',
        `Error: Failed to launch Dolphin.`
      )
    }

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
      await fsPromises.access(outputPath)
    } catch (err) {
      this.mainWindow.webContents.send(
        'videoMsg',
        `Error: Could not access given output path ${outputPath} `
      )
      return reply(event, 'recordClip', requestId)
    }

    let outputDirectoryName = 'output'
    let count = 1
    while (fs.existsSync(path.resolve(`${outputPath}/${outputDirectoryName}`))) {
      outputDirectoryName = `output_${count}`
      count += 1
    }
    fs.mkdirSync(path.resolve(`${outputPath}/${outputDirectoryName}`))

    const config = {
      ...this.config,
      outputPath: path.resolve(`${outputPath}/${outputDirectoryName}`),
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

  async generateVideo(event: IpcMainEvent, data?: RequestEnvelope<{ filterId: string, selectedIds: string[] }>) {
    const { requestId, payload } = unpackRequest<{ filterId: string, selectedIds: string[] }>(data)
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
    } catch(err){
      this.mainWindow.webContents.send('videoMsg',`Error: Could not access given output path ${outputPath} `)
      return reply(event, 'generateVideo', requestId)
    }

    // make directory
    let outputDirectoryName = 'output'
    let count = 1
    while (
      fs.existsSync(path.resolve(`${outputPath}/${outputDirectoryName}`))
    ) {
      outputDirectoryName = `output_${count}`
      count += 1
    }
    fs.mkdirSync(path.resolve(`${outputPath}/${outputDirectoryName}`))

    const config = {
      ...this.config,
      outputPath: path.resolve(`${outputPath}/${outputDirectoryName}`),
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
      dolphinCutoff
    }


    const metadata = await getMetaData(this.archive.path)
    this.archive = new Archive(metadata)

    const filterId = payload?.filterId || 'files'
    const selectedIds = payload?.selectedIds || []

    let finalResults: any[]
    if (selectedIds.length > 0) {
      const numericIds = selectedIds.map((id) => parseInt(id, 10)).filter((n) => !isNaN(n))
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
    finalResults.forEach((result: ClipInterface | FileInterface, index: number) => {
      const hasStart = typeof result.startFrame === 'number' && result.startFrame !== 0
      const hasEnd = typeof result.endFrame === 'number' && result.endFrame !== 0
      const startFrame = hasStart ? result.startFrame : -123
      const endFrame = hasEnd
        ? result.endFrame
        : (result as FileInterface).lastFrame || 99999

      const adjustedStart = startFrame - addStartFrames
      const adjustedEnd = endFrame + addEndFrames

      replays.push({
        index,
        path: result.path,
        startFrame: adjustedStart < -123 ? -123 : adjustedStart,
        endFrame: adjustedEnd,
      })
    })
    if (lastClipOffset && replays.length > 0) {
      replays[replays.length - 1].endFrame += lastClipOffset
    }

    console.log('Replays: ', replays)
    console.log('Config: ', config)
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
    ipcMain.on('removeFilter', this.removeFilter.bind(this))
    ipcMain.on('getResults', this.getResults.bind(this))
    ipcMain.on('getNames', this.getNames.bind(this))
    ipcMain.on('runFilter', this.runFilter.bind(this))
    ipcMain.on('runFilters', this.runFilters.bind(this))
    ipcMain.on('cancelRunningFilters', this.cancelRunningFilters.bind(this))
    ipcMain.on('stopRunningFilters', this.stopRunningFilters.bind(this))
    ipcMain.on('stopFilter', this.stopFilter.bind(this))
    ipcMain.on('cancelFilter', this.cancelFilter.bind(this))
    ipcMain.on('getPath', this.getPath.bind(this))
    ipcMain.on('generateVideo', this.generateVideo.bind(this))
    ipcMain.on('stopVideo', this.stopVideo.bind(this))
    ipcMain.on('cancelVideo', this.cancelVideo.bind(this))
    ipcMain.on('playClip', this.playClip.bind(this))
    ipcMain.on('recordClip', this.recordClip.bind(this))
    ipcMain.on('logPerfEvents', this.logPerfEvents.bind(this))
    ipcMain.on('debugLog', this.debugLog.bind(this))
    ipcMain.on('rendererError', this.logRendererError.bind(this))
    ipcMain.on('testDolphin', this.testDolphin.bind(this))
  }

  async testDolphin() {
    const { dolphinPath, ssbmIsoPath } = this.config
    if (!dolphinPath || !ssbmIsoPath) {
      this.mainWindow.webContents.send('videoMsg', 'Error: Set Dolphin and ISO paths first.')
      return
    }

    try {
      await fsPromises.access(dolphinPath)
    } catch {
      this.mainWindow.webContents.send('videoMsg', `Error: Dolphin not found at ${dolphinPath}`)
      return
    }

    try {
      await fsPromises.access(ssbmIsoPath)
    } catch {
      this.mainWindow.webContents.send('videoMsg', `Error: ISO not found at ${ssbmIsoPath}`)
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
      this.mainWindow.webContents.send('videoMsg', `Error: test.slp not found at ${testSlp}`)
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

    const tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'lm-clipper-test-'))
    this.activeTmpDirs.add(tmpDir)
    const configFile = path.resolve(tmpDir, 'testDolphinConfig.json')
    await fsPromises.writeFile(configFile, JSON.stringify(dolphinConfig))

    this.mainWindow.webContents.send('videoMsg', 'Launching Dolphin test...')

    try {
      const dolphinProcess = spawn(path.resolve(dolphinPath), [
        '-i', configFile,
        '-b',
        '-e', path.resolve(ssbmIsoPath),
        '--cout',
      ])

      const logLines: string[] = []
      const addLog = (line: string) => {
        logLines.push(line)
        console.log('[Dolphin test]', line)
      }

      dolphinProcess.stdout?.on('data', (data: Buffer) => {
        data.toString().split('\n').forEach(l => { if (l.trim()) addLog(`stdout: ${l.trim()}`) })
      })

      dolphinProcess.stderr?.on('data', (data: Buffer) => {
        data.toString().split('\n').forEach(l => { if (l.trim()) addLog(`stderr: ${l.trim()}`) })
      })

      dolphinProcess.on('error', (err) => {
        addLog(`spawn error: ${err.message}`)
        this.mainWindow.webContents.send('videoMsg', `Dolphin error: ${err.message}`)
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
          this.mainWindow.webContents.send('videoMsg', `Dolphin failed (code ${code}): ${lastErr} — Log: ${logPath}`)
        } else if (code !== 0) {
          this.mainWindow.webContents.send('videoMsg', `Dolphin exited with code ${code}. Log: ${logPath}`)
        } else {
          this.mainWindow.webContents.send('videoMsg', `Dolphin test finished. Log: ${logPath}`)
          setTimeout(() => {
            this.mainWindow.webContents.send('videoMsg', '')
          }, 5000)
        }
      })
    } catch (err: any) {
      this.mainWindow.webContents.send('videoMsg', `Failed to launch Dolphin: ${err.message}`)
    }
  }
}
