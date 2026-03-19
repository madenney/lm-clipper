import { BrowserWindow } from 'electron'
import { ConsoleSnapshot, ConsoleLogEntry } from '../../constants/types'
import type Filter from '../../models/Filter'
import type Archive from '../../models/Archive'
import type { VideoJobController } from '../slpToVideo'

type ImportStatus = {
  isImporting: boolean
  current: number
  total: number | null
  queueLength: number
}

export default class ConsoleManager {
  private mainWindow: BrowserWindow
  private consoleState: ConsoleSnapshot
  private consoleLogBuffer: ConsoleLogEntry[]
  private consoleTimer: ReturnType<typeof setInterval> | null
  private getActiveFilter: () => Filter | null
  private getActiveVideoJob: () => VideoJobController | null
  private getActiveImportArchive: () => Archive | null
  private getImportStatus: () => ImportStatus

  constructor(
    mainWindow: BrowserWindow,
    deps: {
      getActiveFilter: () => Filter | null
      getActiveVideoJob: () => VideoJobController | null
      getActiveImportArchive: () => Archive | null
      getImportStatus: () => ImportStatus
    },
  ) {
    this.mainWindow = mainWindow
    this.getActiveFilter = deps.getActiveFilter
    this.getActiveVideoJob = deps.getActiveVideoJob
    this.getActiveImportArchive = deps.getActiveImportArchive
    this.getImportStatus = deps.getImportStatus
    this.consoleState = {
      operation: 'idle',
      operationLabel: '',
      workers: [],
      aggregate: { current: 0, total: 0 },
    }
    this.consoleLogBuffer = []
    this.consoleTimer = null
  }

  startConsole(operation: ConsoleSnapshot['operation'], label: string) {
    this.stopConsole()
    this.consoleState = {
      operation,
      operationLabel: label,
      workers: [],
      aggregate: { current: 0, total: 0 },
    }
    this.consoleTimer = setInterval(() => this.tickConsole(), 1000)
    this.tickConsole()
  }

  stopConsole() {
    if (this.consoleTimer) {
      clearInterval(this.consoleTimer)
      this.consoleTimer = null
    }
    this.consoleState = {
      operation: 'idle',
      operationLabel: '',
      workers: [],
      aggregate: { current: 0, total: 0 },
    }
    this.flushConsole()
  }

  private tickConsole() {
    // Read worker status based on current operation
    if (this.consoleState.operation === 'import') {
      const importArchive = this.getActiveImportArchive()
      const pool = (importArchive as any)?.activeImportPool ?? null
      if (pool) {
        const statuses = pool.getWorkerStatus()
        const now = Date.now()
        this.consoleState.workers = statuses.map(
          (s: { workerId: number; filePath: string | null }) => ({
            id: s.workerId,
            label: s.filePath
              ? s.filePath.split(/[/\\]/).pop() || s.filePath
              : '',
            startedAt: now,
          }),
        )
      }
      const importStatus = this.getImportStatus()
      this.consoleState.aggregate = {
        current: importStatus.current,
        total: importStatus.total || 0,
      }
    } else if (this.consoleState.operation === 'filter') {
      const activeFilter = this.getActiveFilter()
      if (activeFilter) {
        const statuses = activeFilter.getWorkerStatus()
        if (statuses) {
          const now = Date.now()
          this.consoleState.workers = statuses.map((s) => ({
            id: s.workerId,
            label: `Slice ${s.workerId + 1}`,
            progress: `${s.completed.toLocaleString()} / ${s.total.toLocaleString()}`,
            startedAt: now,
          }))
          this.consoleState.aggregate = {
            current: statuses.reduce((a, s) => a + s.completed, 0),
            total: statuses.reduce((a, s) => a + s.total, 0),
          }
        }
      }
    } else if (this.consoleState.operation === 'recording') {
      const activeVideoJob = this.getActiveVideoJob()
      if (activeVideoJob) {
        const statuses = activeVideoJob.getWorkerStatus()
        const now = Date.now()
        this.consoleState.workers = statuses.map((s, i) => ({
          id: i,
          label: s.replayPath
            ? s.replayPath.split(/[/\\]/).pop() || s.replayPath
            : '',
          progress: s.phase !== 'idle' ? s.phase : undefined,
          startedAt: now,
        }))
      }
    }

    this.flushConsole()
  }

  private flushConsole() {
    if (this.mainWindow?.isDestroyed?.()) return
    this.mainWindow.webContents.send('consoleSnapshot', this.consoleState)
    if (this.consoleLogBuffer.length > 0) {
      this.mainWindow.webContents.send('consoleLog', this.consoleLogBuffer)
      this.consoleLogBuffer = []
    }
  }

  pushConsoleLog(level: ConsoleLogEntry['level'], message: string) {
    this.consoleLogBuffer.push({ ts: Date.now(), level, message })
  }

  cleanup() {
    this.stopConsole()
  }
}
