import { BrowserWindow } from 'electron'
import {
  ConsoleSnapshot,
  ConsoleLogEntry,
  ConsoleOperation,
  ConsoleOperationKind,
  ConsoleWorkerStatus,
} from '../../constants/types'
import type Filter from '../../models/Filter'
import type Archive from '../../models/Archive'
import type { VideoJobController } from '../slpToVideo'
import { logMain } from '../logger'

type ImportStatus = {
  isImporting: boolean
  current: number
  total: number | null
  queueLength: number
}

/** Log lines wait this long to be sent together (a run can print thousands). */
const LOG_FLUSH_MS = 200

type Op = ConsoleOperation & {
  /** Reads progress from the matching manager on each tick. */
  live: boolean
}

export default class ConsoleManager {
  private mainWindow: BrowserWindow
  private ops: Op[] = []
  private nextOpId = 1
  private nextLogId = 1
  private lastSent = ''
  private logBuffer: ConsoleLogEntry[] = []
  private logTimer: ReturnType<typeof setTimeout> | null = null
  private tickTimer: ReturnType<typeof setInterval> | null = null
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
  }

  /**
   * Show an operation in the console's status zone. Returns its id for stopConsole.
   * `live: false` for one with no workers of its own (extracting a zip): it only
   * shows its label, instead of reading the import pool's progress.
   */
  startConsole(
    kind: ConsoleOperationKind,
    label: string,
    opts: { live?: boolean } = {},
  ): number {
    const id = this.nextOpId++
    this.ops.push({
      id,
      kind,
      label,
      startedAt: Date.now(),
      workers: [],
      aggregate: { current: 0, total: 0 },
      live: opts.live !== false,
    })
    if (!this.tickTimer) {
      this.tickTimer = setInterval(() => this.tick(), 1000)
      this.tickTimer.unref?.()
    }
    this.tick()
    return id
  }

  /** End one operation (no id: all of them). */
  stopConsole(id?: number) {
    this.ops =
      id === undefined || id === null ? [] : this.ops.filter((o) => o.id !== id)
    if (this.ops.length === 0 && this.tickTimer) {
      clearInterval(this.tickTimer)
      this.tickTimer = null
    }
    this.flush()
  }

  private tick() {
    const now = Date.now()
    // Several operations of one kind share its manager's progress: only the
    // newest live one reads it.
    const reader = new Map<ConsoleOperationKind, Op>()
    for (const op of this.ops) if (op.live) reader.set(op.kind, op)
    for (const op of reader.values()) {
      if (op.kind === 'import') this.readImport(op, now)
      else if (op.kind === 'filter') this.readFilter(op, now)
      else if (op.kind === 'recording') this.readRecording(op, now)
    }
    this.flush()
  }

  /** Keep a worker's start time while it stays on the same file. */
  private keepStart(
    op: Op,
    next: { id: number; label: string; progress?: string }[],
    now: number,
  ): ConsoleWorkerStatus[] {
    return next.map((w) => {
      const before = op.workers.find((p) => p.id === w.id)
      return {
        ...w,
        startedAt: before && before.label === w.label ? before.startedAt : now,
      }
    })
  }

  private readImport(op: Op, now: number) {
    const pool =
      (this.getActiveImportArchive() as any)?.activeImportPool ?? null
    if (pool) {
      const statuses = pool.getWorkerStatus() as {
        workerId: number
        filePath: string | null
      }[]
      op.workers = this.keepStart(
        op,
        statuses.map((s) => ({
          id: s.workerId,
          label: s.filePath
            ? s.filePath.split(/[/\\]/).pop() || s.filePath
            : '',
        })),
        now,
      )
    }
    const status = this.getImportStatus()
    op.aggregate = { current: status.current, total: status.total || 0 }
  }

  private readFilter(op: Op, now: number) {
    const statuses = this.getActiveFilter()?.getWorkerStatus()
    if (!statuses) return
    op.workers = this.keepStart(
      op,
      statuses.map((s) => ({
        id: s.workerId,
        label: `Slice ${s.workerId + 1}`,
        progress: `${s.completed.toLocaleString()} / ${s.total.toLocaleString()}`,
      })),
      now,
    )
    op.aggregate = {
      current: statuses.reduce((a, s) => a + s.completed, 0),
      total: statuses.reduce((a, s) => a + s.total, 0),
    }
  }

  private readRecording(op: Op, now: number) {
    const statuses = this.getActiveVideoJob()?.getWorkerStatus()
    if (!statuses) return
    op.workers = this.keepStart(
      op,
      statuses.map((s, i) => ({
        id: i,
        label: s.replayPath
          ? s.replayPath.split(/[/\\]/).pop() || s.replayPath
          : '',
        progress: s.phase !== 'idle' ? s.phase : undefined,
      })),
      now,
    )
  }

  private snapshot(): ConsoleSnapshot {
    return {
      operations: this.ops.map(({ live: _live, ...op }) => op),
    }
  }

  /** Send the status zone when it changed and any waiting log lines. */
  private flush() {
    if (this.mainWindow?.isDestroyed?.()) return
    const snap = this.snapshot()
    const json = JSON.stringify(snap)
    if (json !== this.lastSent) {
      this.lastSent = json
      this.mainWindow.webContents.send('consoleSnapshot', snap)
    }
    this.flushLogs()
  }

  private flushLogs() {
    if (this.logTimer) {
      clearTimeout(this.logTimer)
      this.logTimer = null
    }
    if (this.logBuffer.length === 0) return
    if (this.mainWindow?.isDestroyed?.()) {
      this.logBuffer = []
      return
    }
    this.mainWindow.webContents.send('consoleLog', this.logBuffer)
    this.logBuffer = []
  }

  /** Add a line. It is also written to main.log, so a report can include it. */
  pushConsoleLog(level: ConsoleLogEntry['level'], message: string) {
    this.logBuffer.push({
      id: this.nextLogId++,
      ts: Date.now(),
      level,
      message,
    })
    logMain(`console ${level}`, message)
    if (!this.logTimer) {
      this.logTimer = setTimeout(() => this.flushLogs(), LOG_FLUSH_MS)
      this.logTimer.unref?.()
    }
  }

  /** A non-blocking warning for the console (a warn entry doesn't pop the
   *  console open; errors do). Sent soon, with no operation running or not. */
  pushConsoleNote(message: string) {
    this.pushConsoleLog('warn', message)
  }

  cleanup() {
    this.stopConsole()
    this.flushLogs()
  }
}
