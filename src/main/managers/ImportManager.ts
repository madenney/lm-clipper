import {
  app,
  ipcMain,
  dialog,
  shell,
  BrowserWindow,
  IpcMainEvent,
} from 'electron'
import { Worker } from 'worker_threads'
import path from 'path'
import { promises as fsPromises } from 'fs'
import { getWorkerExecArgv } from '../../lib'
import { track } from '../telemetry'
import { rendererConfig } from '../configStore'
import { ArchiveInterface, ConfigInterface } from '../../constants/types'
import Archive, { type ImportLibrary } from '../../models/Archive'
import Filter from '../../models/Filter'
import { getMetaData } from '../dbAsync'
import { getSlpzPath } from '../util'
import { askDialog } from '../askRenderer'
import {
  RequestEnvelope,
  unpackRequest,
  reply,
  buildShallowArchive,
} from '../ipcUtils'
import type ConsoleManager from './ConsoleManager'
import { extractZipWithStatus } from '../zipImportStatus'
import { zipImportFolder } from '../zipImportFolder'
import {
  describeFailures,
  describeSkips,
  importSummary,
} from '../../lib/importSkips'
import { slpzDefaultOutputDir } from '../../lib/slpzDecompress'

/** The user cancelled while ZIPs were being extracted for an import. */
export class ImportCancelledError extends Error {
  constructor() {
    super('Import cancelled.')
    this.name = 'ImportCancelledError'
  }
}

type ImportStatus = {
  isImporting: boolean
  current: number
  total: number | null
  queueLength: number
  /** 'extracting' while a ZIP is unpacked before its import (current/total
   *  are then the ZIP's entries); null while replays are imported. */
  phase?: 'extracting' | null
  /** The ZIP being extracted. */
  label?: string
}

export default class ImportManager {
  private mainWindow: BrowserWindow
  private getConfig: () => ConfigInterface
  private getLibrary?: () => ImportLibrary
  private getConfigPath: () => string
  private getArchive: () => ArchiveInterface | null
  private setArchive: (_archive: ArchiveInterface | null) => void
  private getArchiveVersion: () => number
  private autoCreateUntitledProject: () => Promise<any>
  private consoleManager: ConsoleManager
  /** This import's entry in the console's status zone. */
  private importConsoleId: number | undefined

  private saveConfig?: () => Promise<void>

  currentImportAbortController: AbortController | null
  importQueue: string[][]
  importInProgress: boolean
  currentCountWorker: Worker | null
  countWorkerExecArgv?: string[]
  importStatus: ImportStatus
  pendingSlpzDefaultDir: string
  activeImportArchive: import('../../models/Archive').default | null
  cancelSlpzWizard: (() => void) | null
  cancelZipWizard: (() => void) | null

  constructor(
    mainWindow: BrowserWindow,
    deps: {
      /** The replay library: headers it already read aren't parsed again. */
      getLibrary?: () => ImportLibrary
      getConfig: () => ConfigInterface
      getConfigPath: () => string
      /** Save the config the safe way (queued, written through a temp file). */
      saveConfig?: () => Promise<void>
      getArchive: () => ArchiveInterface | null
      setArchive: (_archive: ArchiveInterface | null) => void
      getArchiveVersion: () => number
      autoCreateUntitledProject: () => Promise<any>
      consoleManager: ConsoleManager
    },
  ) {
    this.mainWindow = mainWindow
    this.getConfig = deps.getConfig
    this.getLibrary = deps.getLibrary
    this.getConfigPath = deps.getConfigPath
    this.saveConfig = deps.saveConfig
    this.getArchive = deps.getArchive
    this.setArchive = deps.setArchive
    this.getArchiveVersion = deps.getArchiveVersion
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
    this.pendingSlpzDefaultDir = ''
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

  // Always emit a terminal import status so the renderer's progress modal
  // closes. Used by every early-exit path in runImport (not just the happy
  // path) — a missing finished:true leaves the import spinner stuck forever.
  private emitImportFinished(cancelled: boolean) {
    this.setImportStatus({
      isImporting: false,
      current: 0,
      total: null,
      queueLength: this.importQueue.length,
    })
    this.mainWindow.webContents.send('importingFileUpdate', {
      finished: true,
      cancelled,
    })
  }

  /** Import files a transfer already prepared. Duplicate detection is always on:
   *  a retried or overlapping batch must never add the same replay twice. */
  async importPrepared(
    filePaths: string[],
    projectPath: string,
    signal: AbortSignal,
    onProgress: (_current: number, _total: number) => void,
  ) {
    if (this.importInProgress)
      throw new Error('Another import is running. Retry when it finishes.')
    if (signal.aborted || this.getArchive()?.path !== projectPath)
      throw new Error('Open the destination project to continue importing.')
    this.importInProgress = true
    const abort = () => this.currentImportAbortController?.abort()
    signal.addEventListener('abort', abort, { once: true })
    try {
      this.setImportStatus({ isImporting: true, current: 0, total: null })
      // Transfers hand over files in Clipper's own library: a .slpz there is
      // read as it is, never decompressed or replaced (whatever slpzMode says).
      const result = await this.runImport(filePaths, onProgress, {
        slpzMode: 'keep',
      })
      if (!result || result.terminated)
        throw new Error(
          'Import interrupted. Resume to import the remaining replays.',
        )
      return {
        inserted: result.inserted,
        failed: result.failed,
        skipped: result.skipped ?? 0,
        duplicates: result.duplicates ?? 0,
      }
    } finally {
      signal.removeEventListener('abort', abort)
      this.importInProgress = false
      this.setImportStatus({ isImporting: false, current: 0, total: null })
      this.processImportQueue()
    }
  }

  private async runImport(
    filePaths: string[],
    onProgress?: (_current: number, _total: number) => void,
    options: { slpzMode?: 'keep' } = {},
  ) {
    const archive = this.getArchive()
    const archiveVersion = this.getArchiveVersion()
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
        this.emitImportFinished(true)
        return
      }

      if ((zipChoice as any).skip) {
        // Skip zip files — continue import with only non-zip files
        filePaths = nonZipFiles
        if (filePaths.length === 0) {
          this.emitImportFinished(false)
          return
        }
      } else {
        const extractedDirs: string[] = []
        for (const zipFile of zipFiles) {
          // extractZip logs its own errors; anything before it is logged here.
          let extractStarted = false
          try {
            // The same folder for the same ZIP every time
            // (zipImportFolder.ts): a ZIP imported again adds nothing.
            const { replaysDir, reused } = await zipImportFolder(
              zipFile,
              zipChoice.outputDir,
              (dir) => {
                extractStarted = true
                return this.extractZip(zipFile, dir)
              },
            )
            if (reused)
              this.consoleManager.pushConsoleLog(
                'info',
                `${path.basename(zipFile)} was extracted before (${path.dirname(replaysDir)}); importing those replays`,
              )
            if (zipChoice.deleteOriginal) {
              // To the Recycle Bin / Trash, never a permanent delete: the
              // replays in it may be wanted again (launch review WIN-21).
              try {
                await shell.trashItem(zipFile)
              } catch {
                // Non-fatal: the zip stays where it is.
              }
            }
            extractedDirs.push(replaysDir)
          } catch (error) {
            // A failed extraction leaves no folder behind; the ZIP is untouched.
            if (error instanceof ImportCancelledError) {
              // Cancel stops the whole batch, not just the current ZIP.
              this.emitImportFinished(true)
              return
            }
            console.error(`Failed to extract ${zipFile}:`, error)
            if (!extractStarted)
              this.consoleManager.pushConsoleLog(
                'error',
                `Could not extract ${path.basename(zipFile)}: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              )
          }
        }

        // Replace zip paths with extracted directories
        filePaths = [...nonZipFiles, ...extractedDirs]
        if (filePaths.length === 0) {
          this.emitImportFinished(false)
          return
        }
      } // end else (not skip)
    }

    const config = this.getConfig()
    const fileCountBefore = archive.files || 0
    // Always skip files already in the project: re-importing a folder used to
    // add every game again. The check is one indexed lookup by path (~0.1 ms on
    // a 2.8M-game project), far cheaper than parsing the file it saves.
    const detectDuplicates = true
    const maxWorkers = Math.max(1, config.numFilterThreads || 1)
    const importAbortController = new AbortController()
    this.currentImportAbortController = importAbortController

    // Check if batch may contain .slpz files and resolve decompression config
    let mayHaveSlpz = false
    for (const p of filePaths) {
      const ext = path.extname(p).toLowerCase()
      if (ext === '.slpz') {
        mayHaveSlpz = true
        break
      }
      if (ext !== '.slp' && ext !== '.slpz') {
        try {
          const entries = await fsPromises.readdir(p, { withFileTypes: true })
          // Descend into extracted ZIP subfolders too.
          const containsSlpz = async (dir: string): Promise<boolean> => {
            for (const entry of await fsPromises.readdir(dir, {
              withFileTypes: true,
            })) {
              if (entry.isFile() && /\.slpz$/i.test(entry.name)) return true
              if (
                entry.isDirectory() &&
                (await containsSlpz(path.join(dir, entry.name)))
              )
                return true
            }
            return false
          }
          if (
            entries.some((e) => e.isFile() && /\.slpz$/i.test(e.name)) ||
            (await containsSlpz(p))
          ) {
            mayHaveSlpz = true
            break
          }
        } catch {
          // skip
        }
      }
    }

    let slpzConfig:
      | {
          slpzBinaryPath: string
          slpzMode: 'extract' | 'replace' | 'keep'
          slpzOutputDir: string
          keepInside?: string
        }
      | undefined

    if (mayHaveSlpz) {
      const resolvedMode = options.slpzMode || config.slpzMode || 'keep'
      if (resolvedMode === 'ask') {
        // The wizard's default "extract to" folder (slpzDefaultOutputDir).
        this.pendingSlpzDefaultDir = await slpzDefaultOutputDir(filePaths)
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
        if (userChoice.remember && userChoice.mode !== 'skip') {
          // 'skip' isn't a persistable slpzMode (only ask/extract/replace/keep).
          const currentConfig = this.getConfig()
          currentConfig.slpzMode = userChoice.mode
          if (userChoice.outputDir) {
            currentConfig.slpzOutputDir = userChoice.outputDir
          }
          // Through the controller's queue and temp-file write: a direct
          // writeFile could interleave with another save and garble the config
          // (launch review REL-3, WIN-25).
          if (this.saveConfig) {
            this.saveConfig().catch(() => {})
          } else {
            fsPromises
              .writeFile(
                this.getConfigPath(),
                JSON.stringify(currentConfig, null, 2),
                { mode: 0o600 },
              )
              .catch((error) =>
                console.error('Could not save the SLPZ choice:', error),
              )
          }
          this.mainWindow.webContents.send(
            'config',
            rendererConfig(currentConfig),
          )
        }
      } else {
        slpzConfig = {
          slpzBinaryPath: config.slpzPath || getSlpzPath(),
          slpzMode: resolvedMode,
          slpzOutputDir: config.slpzOutputDir || '',
        }
      }
      // Clipper's library holds its own downloads: never decompressed or
      // replaced there, whatever the mode (models/ImportWorker.ts).
      const libraryFolder = this.getLibrary?.()?.folder
      if (slpzConfig && libraryFolder) slpzConfig.keepInside = libraryFolder
    }

    this.startCountWorker(filePaths)
    this.activeImportArchive = archive as any
    this.importConsoleId = this.consoleManager.startConsole('import', 'Import')
    this.mainWindow.webContents.send('importingFileUpdate', {
      current: 0,
      total: 0,
    })

    const result = await archive.addFiles!(
      filePaths,
      ({ current, total }) => {
        onProgress?.(current || 0, total || 0)
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
        library: this.getLibrary?.(),
      },
    )
    const {
      terminated,
      failed,
      failedReasons,
      inserted,
      skipped,
      skippedReasons,
      duplicates,
    } = result

    // Dev-only testing aid: keep the import "running" a while longer, to try
    // things that happen mid-import (e.g. picking a welcome option while the
    // first import is still going). Start with LUNAR_SLOW_IMPORT_MS=20000 ns.
    const slowMs = Number(process.env.LUNAR_SLOW_IMPORT_MS)
    if (!app.isPackaged && slowMs > 0 && !terminated)
      await new Promise((resolve) => {
        setTimeout(resolve, Math.min(slowMs, 600_000))
      })

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

    // A project switch can finish while an old import is winding down. Never
    // replace the newly opened project with the old import's archive.
    if (
      this.getArchiveVersion() !== archiveVersion ||
      this.getArchive()?.path !== archive.path
    ) {
      this.emitImportFinished(true)
      return { ...result, terminated: true }
    }

    // Refresh archive from DB to get the real file count
    let currentArchive = this.getArchive()
    try {
      const metadata = await getMetaData(archive.path)
      if (this.getArchive()?.path !== archive.path)
        return { ...result, terminated: true }
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
      (currentArchive.files ?? 0) > 0
    ) {
      const gameFilter = currentArchive.filters.find((f) => f.type === 'files')
      if (gameFilter) {
        const filter = new Filter(gameFilter)
        const numThreads = config.numFilterThreads || 1
        await filter.run3(currentArchive.path, 'files', numThreads, () => {})
        try {
          const metadata = await getMetaData(currentArchive.path)
          if (this.getArchive()?.path !== archive.path)
            return { ...result, terminated: true }
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
      `${terminated ? 'Import cancelled' : 'Import complete'}: ${importSummary(
        inserted,
        duplicates ?? 0,
      )}`,
    )
    // Games left out, and why (a silent drop reads as lost games).
    for (const line of [
      ...describeSkips(skippedReasons),
      ...describeFailures(failedReasons),
    ])
      this.consoleManager.pushConsoleLog('warn', line)
    this.consoleManager.stopConsole(this.importConsoleId)
    this.importConsoleId = undefined
    if (!terminated) {
      // Count the rows addFiles actually wrote. Diffing archive.files can't work
      // here: inserting invalidates the cached file count, so the refreshed
      // archive reports null (counts hydrate lazily) and the diff was always 0.
      track('import_completed', { added: inserted, failed })
    }
    this.mainWindow.webContents.send('importingFileUpdate', {
      finished: true,
      cancelled: terminated,
      failed,
      failedReasons,
      // So the renderer can say why nothing was added (none found, all
      // duplicates, none readable) instead of silently doing nothing.
      inserted,
      skipped,
      skippedReasons,
      duplicates,
      archive: buildShallowArchive(currentArchive),
    })
    return result
  }

  promptSlpzWizard(): Promise<{
    mode: 'extract' | 'replace' | 'keep' | 'skip'
    outputDir: string
    remember: boolean
  } | null> {
    return new Promise((resolve) => {
      let resolved = false
      let timer: ReturnType<typeof setTimeout> | null = null

      const cleanup = () => {
        ipcMain.removeListener('slpzWizardResponse', handler)
        this.cancelSlpzWizard = null
        this.pendingSlpzDefaultDir = ''
        if (timer) {
          clearTimeout(timer)
          timer = null
        }
      }

      const done = (
        data: {
          mode: 'extract' | 'replace' | 'keep' | 'skip'
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
          mode: 'extract' | 'replace' | 'keep' | 'skip'
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

      const defaultOutputDir = this.pendingSlpzDefaultDir
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

  /** Unpack one ZIP before its import, with its status in the top bar and
   *  the console (zipImportStatus.ts). Cancel throws ImportCancelledError. */
  async extractZip(zipPath: string, outputDir: string) {
    const abort = new AbortController()
    this.currentImportAbortController = abort
    try {
      return await extractZipWithStatus(zipPath, outputDir, {
        signal: abort.signal,
        setStatus: (next) => this.setImportStatus(next),
        console: this.consoleManager,
      })
    } catch (error) {
      if (abort.signal.aborted) throw new ImportCancelledError()
      throw error
    } finally {
      if (this.currentImportAbortController === abort)
        this.currentImportAbortController = null
    }
  }

  /**
   * The file / folder picker for "Choose replays". Windows and Linux dialogs
   * cannot be both a file and a folder picker (asking for both gives a folder
   * picker only, so a .zip or a few .slp files could never be chosen): there the
   * user says which first. macOS has the combined dialog. (Launch review UX-1.)
   */
  private async pickReplays(
    platform: NodeJS.Platform = process.platform,
  ): Promise<{ canceled: boolean; filePaths: string[] }> {
    const filters = [
      { name: 'Slippi Replays', extensions: ['slp', 'slpz', 'zip'] },
    ]
    if (platform === 'darwin')
      return dialog.showOpenDialog({
        properties: ['openFile', 'openDirectory', 'multiSelections'],
        filters,
      })
    const { response } = await askDialog(this.mainWindow, {
      type: 'question',
      title: 'Choose replays',
      message: 'What do you want to add?',
      detail:
        'Pick replay files (.slp, .slpz or a .zip of them), or a whole folder of replays.',
      buttons: ['Files…', 'A folder…', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
    })
    if (response === 2) return { canceled: true, filePaths: [] }
    return dialog.showOpenDialog(
      response === 1
        ? { properties: ['openDirectory'] }
        : { properties: ['openFile', 'multiSelections'], filters },
    )
  }

  async addFilesManual(event: IpcMainEvent, data?: RequestEnvelope<null>) {
    const { requestId } = unpackRequest<null>(data)
    // Ask first: cancelling from the start screen must leave it there, not
    // open My Replays with nothing added.
    const { canceled, filePaths } = await this.pickReplays()
    const current = this.getArchive()
    if (canceled || !filePaths || filePaths.length === 0) {
      return reply(
        event,
        'addFilesManual',
        requestId,
        current?.shallowCopy ? buildShallowArchive(current) : null,
      )
    }

    let archive = current
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
