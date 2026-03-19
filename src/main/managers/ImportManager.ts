import { ipcMain, dialog, BrowserWindow, IpcMainEvent } from 'electron'
import { Worker } from 'worker_threads'
import { execFileSync, execSync } from 'child_process'
import path from 'path'
import fs from 'fs'
import { getWorkerExecArgv } from '../../lib'
import { ArchiveInterface, ConfigInterface } from '../../constants/types'
import Archive from '../../models/Archive'
import Filter from '../../models/Filter'
import { getMetaData } from '../db'
import { getSlpzPath } from '../util'
import {
  RequestEnvelope,
  unpackRequest,
  reply,
  buildShallowArchive,
} from '../ipcUtils'
import type ConsoleManager from './ConsoleManager'

type ImportStatus = {
  isImporting: boolean
  current: number
  total: number | null
  queueLength: number
}

export default class ImportManager {
  private mainWindow: BrowserWindow
  private getConfig: () => ConfigInterface
  private getConfigPath: () => string
  private getArchive: () => ArchiveInterface | null
  private setArchive: (_archive: ArchiveInterface | null) => void
  private autoCreateUntitledProject: () => Promise<any>
  private consoleManager: ConsoleManager

  currentImportAbortController: AbortController | null
  importQueue: string[][]
  importInProgress: boolean
  currentCountWorker: Worker | null
  countWorkerExecArgv?: string[]
  importStatus: ImportStatus
  pendingSlpzSourceDir: string
  activeImportArchive: import('../../models/Archive').default | null
  cancelSlpzWizard: (() => void) | null
  cancelZipWizard: (() => void) | null

  constructor(
    mainWindow: BrowserWindow,
    deps: {
      getConfig: () => ConfigInterface
      getConfigPath: () => string
      getArchive: () => ArchiveInterface | null
      setArchive: (_archive: ArchiveInterface | null) => void
      autoCreateUntitledProject: () => Promise<any>
      consoleManager: ConsoleManager
    },
  ) {
    this.mainWindow = mainWindow
    this.getConfig = deps.getConfig
    this.getConfigPath = deps.getConfigPath
    this.getArchive = deps.getArchive
    this.setArchive = deps.setArchive
    this.autoCreateUntitledProject = deps.autoCreateUntitledProject
    this.consoleManager = deps.consoleManager

    this.currentImportAbortController = null
    this.importQueue = []
    this.importInProgress = false
    this.currentCountWorker = null
    this.countWorkerExecArgv = getWorkerExecArgv()
    this.importStatus = {
      isImporting: false,
      current: 0,
      total: null,
      queueLength: 0,
    }
    this.pendingSlpzSourceDir = ''
    this.activeImportArchive = null
    this.cancelSlpzWizard = null
    this.cancelZipWizard = null
  }

  async getImportStatusHandler(
    event: IpcMainEvent,
    data?: RequestEnvelope<null>,
  ) {
    const { requestId } = unpackRequest<null>(data)
    return reply(event, 'getImportStatus', requestId, this.importStatus)
  }

  setImportStatus(next: Partial<ImportStatus>) {
    this.importStatus = { ...this.importStatus, ...next }
    if (this.mainWindow?.isDestroyed?.()) return
    this.mainWindow.webContents.send('importStatus', this.importStatus)
  }

  stopCountWorker() {
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
      new URL('../ImportCountWorker.ts', import.meta.url),
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

  enqueueImport(filePaths: string[]) {
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
    const archive = this.getArchive()
    if (!archive || !archive.addFiles) {
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

    // Extract zip files before import
    const zipFiles = filePaths.filter(
      (p) => path.extname(p).toLowerCase() === '.zip',
    )
    const nonZipFiles = filePaths.filter(
      (p) => path.extname(p).toLowerCase() !== '.zip',
    )

    if (zipFiles.length > 0) {
      const zipChoice = await this.promptZipWizard(zipFiles)
      if (!zipChoice) {
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

      if ((zipChoice as any).skip) {
        // Skip zip files — continue import with only non-zip files
        filePaths = nonZipFiles
        if (filePaths.length === 0) return
      } else {
        const extractedDirs: string[] = []
        for (const zipFile of zipFiles) {
          try {
            const zipName = path.basename(zipFile, '.zip')
            const extractDir = path.join(zipChoice.outputDir, zipName)
            fs.mkdirSync(extractDir, { recursive: true })
            this.extractZip(zipFile, extractDir)
            if (zipChoice.deleteOriginal) {
              try {
                fs.unlinkSync(zipFile)
              } catch {
                // Non-fatal
              }
            }
            extractedDirs.push(extractDir)
          } catch (error) {
            console.error(`Failed to extract ${zipFile}:`, error)
          }
        }

        // Replace zip paths with extracted directories
        filePaths = [...nonZipFiles, ...extractedDirs]
        if (filePaths.length === 0) return
      } // end else (not skip)
    }

    const config = this.getConfig()
    const fileCountBefore = archive.files || 0
    const detectDuplicates = config.detectDuplicatesOnImport !== false
    const maxWorkers = Math.max(1, config.numFilterThreads || 1)
    const importAbortController = new AbortController()
    this.currentImportAbortController = importAbortController

    // Check if batch may contain .slpz files and resolve decompression config
    const mayHaveSlpz = filePaths.some((p) => {
      const ext = path.extname(p).toLowerCase()
      if (ext === '.slpz') return true
      // For directories, do a quick shallow check for .slpz files
      if (ext === '') {
        try {
          const entries = fs.readdirSync(p, { withFileTypes: true })
          return entries.some(
            (e) => e.isFile() && e.name.toLowerCase().endsWith('.slpz'),
          )
        } catch {
          return false
        }
      }
      return false
    })

    let slpzConfig:
      | {
          slpzBinaryPath: string
          slpzMode: 'extract' | 'replace'
          slpzOutputDir: string
        }
      | undefined

    if (mayHaveSlpz) {
      // Determine source directory for default extract path
      const slpzFiles = filePaths.filter(
        (p) => path.extname(p).toLowerCase() === '.slpz',
      )
      this.pendingSlpzSourceDir = slpzFiles.length
        ? path.dirname(slpzFiles[0])
        : path.dirname(filePaths[0])

      const resolvedMode = config.slpzMode || 'ask'
      if (resolvedMode === 'ask') {
        const userChoice = await this.promptSlpzWizard()
        if (!userChoice) {
          // User cancelled
          this.currentImportAbortController = null
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
        if (userChoice.mode === 'skip') {
          // Skip .slpz files — continue import without decompression
          slpzConfig = undefined
        } else {
          slpzConfig = {
            slpzBinaryPath: config.slpzPath || getSlpzPath(),
            slpzMode: userChoice.mode,
            slpzOutputDir: userChoice.outputDir || '',
          }
        }
        if (userChoice.remember) {
          const currentConfig = this.getConfig()
          currentConfig.slpzMode = userChoice.mode
          if (userChoice.outputDir) {
            currentConfig.slpzOutputDir = userChoice.outputDir
          }
          fs.writeFileSync(
            this.getConfigPath(),
            JSON.stringify(currentConfig, null, 2),
          )
          this.mainWindow.webContents.send('config', currentConfig)
        }
      } else {
        slpzConfig = {
          slpzBinaryPath: config.slpzPath || getSlpzPath(),
          slpzMode: resolvedMode,
          slpzOutputDir: config.slpzOutputDir || '',
        }
      }
    }

    this.startCountWorker(filePaths)
    this.activeImportArchive = archive as any
    this.consoleManager.startConsole('import', 'Import')
    this.mainWindow.webContents.send('importingFileUpdate', {
      current: 0,
      total: 0,
    })

    const result = await archive.addFiles!(
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
        slpzConfig,
      },
    )
    const { terminated, failed } = result

    if (this.currentImportAbortController === importAbortController) {
      this.currentImportAbortController = null
    }
    this.stopCountWorker()

    if (failed > 0) {
      console.log(`Import finished with ${failed} failed file(s)`)
      this.consoleManager.pushConsoleLog(
        'warn',
        `Import finished with ${failed} failed file(s)`,
      )
    }

    // Refresh archive from DB to get the real file count
    let currentArchive = this.getArchive()
    try {
      const metadata = await getMetaData(archive.path)
      const newArchive = new Archive(metadata)
      this.setArchive(newArchive)
      currentArchive = newArchive
    } catch (error) {
      console.error('Error refreshing archive after import:', error)
    }

    // First import (0 -> N files): auto-run the game filter
    if (
      fileCountBefore === 0 &&
      !terminated &&
      currentArchive &&
      currentArchive.files > 0
    ) {
      const gameFilter = currentArchive.filters.find((f) => f.type === 'files')
      if (gameFilter) {
        const filter = new Filter(gameFilter)
        const numThreads = config.numFilterThreads || 1
        await filter.run3(currentArchive.path, 'files', numThreads, () => {})
        try {
          const metadata = await getMetaData(currentArchive.path)
          const newArchive = new Archive(metadata)
          this.setArchive(newArchive)
          currentArchive = newArchive
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
    this.consoleManager.pushConsoleLog(
      'info',
      terminated ? 'Import cancelled' : 'Import complete',
    )
    this.consoleManager.stopConsole()
    this.mainWindow.webContents.send('importingFileUpdate', {
      finished: true,
      cancelled: terminated,
      failed,
      archive: buildShallowArchive(currentArchive),
    })
  }

  promptSlpzWizard(): Promise<{
    mode: 'extract' | 'replace' | 'skip'
    outputDir: string
    remember: boolean
  } | null> {
    return new Promise((resolve) => {
      let resolved = false
      let timer: ReturnType<typeof setTimeout> | null = null

      const cleanup = () => {
        ipcMain.removeListener('slpzWizardResponse', handler)
        this.cancelSlpzWizard = null
        this.pendingSlpzSourceDir = ''
        if (timer) {
          clearTimeout(timer)
          timer = null
        }
      }

      const done = (
        data: {
          mode: 'extract' | 'replace'
          outputDir: string
          remember: boolean
        } | null,
      ) => {
        if (resolved) return
        resolved = true
        cleanup()
        resolve(data)
      }

      const handler = (
        _event: IpcMainEvent,
        data: {
          mode: 'extract' | 'replace'
          outputDir: string
          remember: boolean
        } | null,
      ) => {
        done(data)
      }

      this.cancelSlpzWizard = () => {
        this.mainWindow.webContents.send('dismissSlpzWizard')
        done(null)
      }

      timer = setTimeout(() => {
        this.mainWindow.webContents.send('dismissSlpzWizard')
        done(null)
      }, 120000)

      ipcMain.on('slpzWizardResponse', handler)

      const defaultOutputDir = this.pendingSlpzSourceDir
        ? path.join(this.pendingSlpzSourceDir, 'slp')
        : ''
      this.mainWindow.webContents.send('showSlpzWizard', {
        defaultOutputDir,
      })
    })
  }

  promptZipWizard(zipFiles: string[]): Promise<{
    outputDir: string
    deleteOriginal: boolean
    skip?: boolean
  } | null> {
    return new Promise((resolve) => {
      let resolved = false
      let timer: ReturnType<typeof setTimeout> | null = null

      const cleanup = () => {
        ipcMain.removeListener('zipWizardResponse', handler)
        this.cancelZipWizard = null
        if (timer) {
          clearTimeout(timer)
          timer = null
        }
      }

      const done = (
        data: { outputDir: string; deleteOriginal: boolean } | null,
      ) => {
        if (resolved) return
        resolved = true
        cleanup()
        resolve(data)
      }

      const handler = (
        _event: IpcMainEvent,
        data: { outputDir: string; deleteOriginal: boolean } | null,
      ) => {
        done(data)
      }

      this.cancelZipWizard = () => {
        this.mainWindow.webContents.send('dismissZipWizard')
        done(null)
      }

      timer = setTimeout(() => {
        this.mainWindow.webContents.send('dismissZipWizard')
        done(null)
      }, 120000)

      ipcMain.on('zipWizardResponse', handler)

      const defaultOutputDir = path.dirname(zipFiles[0])
      this.mainWindow.webContents.send('showZipWizard', {
        zipFiles,
        defaultOutputDir,
      })
    })
  }

  extractZip(zipPath: string, outputDir: string) {
    if (process.platform === 'win32') {
      execSync(
        `powershell -Command "Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${outputDir.replace(/'/g, "''")}' -Force"`,
        { timeout: 300000 },
      )
    } else {
      execFileSync('unzip', ['-o', '-q', zipPath, '-d', outputDir], {
        timeout: 300000,
      })
    }
  }

  async addFilesManual(event: IpcMainEvent, data?: RequestEnvelope<null>) {
    const { requestId } = unpackRequest<null>(data)
    let archive = this.getArchive()
    if (!archive) {
      try {
        await this.autoCreateUntitledProject()
        archive = this.getArchive()
      } catch (error) {
        console.error('Error auto-creating project for import:', error)
        return reply(event, 'addFilesManual', requestId, {
          error: 'Failed to create project',
        })
      }
    }
    if (!archive || !archive.addFiles || !archive.shallowCopy) {
      return reply(event, 'addFilesManual', requestId, {
        error: 'archive undefined',
      })
    }

    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: ['openFile', 'openDirectory', 'multiSelections'],
      filters: [{ name: 'Slippi Replays', extensions: ['slp', 'slpz', 'zip'] }],
    })
    if (canceled || !filePaths || filePaths.length === 0) {
      return reply(
        event,
        'addFilesManual',
        requestId,
        buildShallowArchive(archive),
      )
    }

    reply(event, 'addFilesManual', requestId, buildShallowArchive(archive))
    this.enqueueImport(filePaths)
    return undefined
  }

  async addDroppedFiles(event: IpcMainEvent, data: RequestEnvelope<string[]>) {
    const { requestId, payload } = unpackRequest<string[]>(data)
    let archive = this.getArchive()
    if (!archive) {
      try {
        await this.autoCreateUntitledProject()
        archive = this.getArchive()
      } catch (error) {
        console.error('Error auto-creating project for drop import:', error)
        return reply(event, 'addDroppedFiles', requestId, {
          error: 'Failed to create project',
        })
      }
    }
    if (!archive || !archive.addFiles || !archive.shallowCopy)
      return reply(event, 'addDroppedFiles', requestId, {
        error: 'archive undefined',
      })
    reply(event, 'addDroppedFiles', requestId, buildShallowArchive(archive))
    this.enqueueImport(payload || [])
    return undefined
  }

  _abortImport() {
    this.importQueue = []
    this.stopCountWorker()
    if (this.cancelSlpzWizard) {
      this.cancelSlpzWizard()
    }
    if (this.cancelZipWizard) {
      this.cancelZipWizard()
    }
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

  cleanup() {
    this.importQueue = []
    if (this.currentImportAbortController) {
      this.currentImportAbortController.abort()
      this.currentImportAbortController = null
    }
    this.stopCountWorker()
  }
}
