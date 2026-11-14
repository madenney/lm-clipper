/**
 * Runs a background check over the open project's games: the one for CPU
 * players (CpuScanWorker.ts) and the one for game lengths
 * (LastFrameScanWorker.ts) each have their own control. For the open
 * project: one worker at a time, paused while an import or filter runs, and
 * stopped before its project is closed, copied, compacted or switched. Kept out
 * of controller.ts so its lifecycle can be tested with a fake worker.
 *
 * stop() resolves only once the worker's connection to the project is gone,
 * also when it's called again while an earlier stop is still finishing, so
 * callers that close or copy the project file can await it.
 */
import type { CpuScanCounts } from '../lib/cpuPlayers'

/** The counts every check reports (each adds its own). */
export type ScanCounts = {
  total: number
  checked: number
  missing: number
  unreachable?: boolean
}

export type ScanState = 'running' | 'paused' | 'stopped' | 'done' | 'failed'

/** A check's state for the open project, as the renderer shows it. */
export type ScanStatus<C extends ScanCounts> = C & {
  projectPath: string
  state: ScanState
}

const CPU_BLANK: CpuScanCounts = {
  total: 0,
  checked: 0,
  cpuGames: 0,
  missing: 0,
  unreadable: 0,
}

/** The parts of a worker_threads Worker the control uses. */
export type ScanWorker = {
  postMessage: (_message: unknown) => void
  terminate: () => Promise<number>
  on: (_event: 'message', _listener: (_message: unknown) => void) => unknown
  once: (
    _event: 'error' | 'exit',
    _listener: (_error?: unknown) => void,
  ) => unknown
}

export type CpuScanDeps<C extends ScanCounts = CpuScanCounts> = {
  spawn: (_projectPath: string) => ScanWorker
  /** An import or filter run is going: the check pauses. */
  isBusy: () => boolean
  publish: (_status: ScanStatus<C> | null) => void
  /** The counts before the worker reports any (the CPU check's by default). */
  blank?: C
  /** For the log (default 'cpu scan'). */
  name?: string
  log: (_message: string, _data?: unknown) => void
  /** How often busy is looked at (ms). */
  pollMs?: number
}

type WorkerMessage = ScanCounts & {
  type: string
  message?: string
  stopped?: boolean
}

/**
 * A continued check's counts against the original total. Games an earlier run
 * settled (checked and not missing) aren't picked again, so they're added to
 * both the total and the checked count; missing ones are tried again and
 * counted by the new run. Other counts (repaired, CPU games, ...) add up.
 */
export function withCarry<C extends ScanCounts>(
  counts: C,
  carried: C | null,
): C {
  if (!carried) return counts
  const settled = Math.max(0, carried.checked - carried.missing)
  const out: Record<string, unknown> = { ...counts }
  for (const [key, value] of Object.entries(carried)) {
    if (key === 'missing' || key === 'unreachable') continue
    const now = (counts as Record<string, unknown>)[key]
    if (typeof value !== 'number') continue
    if (key === 'total' || key === 'checked')
      out[key] = (typeof now === 'number' ? now : 0) + settled
    else out[key] = (typeof now === 'number' ? now : 0) + value
  }
  return out as C
}

export default class CpuScanControl<C extends ScanCounts = CpuScanCounts> {
  private worker: ScanWorker | null = null

  private current: ScanStatus<C> | null = null

  private busyTimer: ReturnType<typeof setInterval> | null = null

  /** Terminations not finished yet: stop() waits for all of them. */
  private ending = new Set<Promise<unknown>>()

  /** Projects whose check the user stopped: not started again this session
   *  unless they press Continue. */
  private stoppedFor = new Set<string>()

  /** Projects with every game checked: imports record `cpu` themselves, so
   *  there's nothing to look for again this session. */
  private complete = new Set<string>()

  /** What a check the user stopped had done, kept for Continue: the new
   *  worker counts only the games still left, and the bar keeps counting
   *  against the original total ("1,200 of 63,336", not "of 62,136"). */
  private carry: { projectPath: string; counts: C } | null = null

  private deps: CpuScanDeps<C>

  constructor(deps: CpuScanDeps<C>) {
    this.deps = deps
  }

  private get name() {
    return this.deps.name ?? 'cpu scan'
  }

  get status() {
    return this.current
  }

  get running() {
    return this.worker !== null
  }

  /** The status for this project, or null when it's about another one. */
  statusFor(projectPath: string | null | undefined) {
    return projectPath && this.current?.projectPath === projectPath
      ? this.current
      : null
  }

  private publish(status: ScanStatus<C> | null) {
    this.current = status
    this.deps.publish(status)
  }

  /** Start the check for this project unless it's running, done or stopped. */
  start(projectPath: string | null | undefined) {
    if (
      !projectPath ||
      this.stoppedFor.has(projectPath) ||
      this.complete.has(projectPath)
    )
      return
    if (this.worker && this.current?.projectPath === projectPath) return
    // Another project's check (shouldn't happen: closing stops it).
    if (this.worker) this.detach(this.worker)
    const worker = this.deps.spawn(projectPath)
    this.worker = worker
    let busy = false
    const carried =
      this.carry?.projectPath === projectPath ? this.carry.counts : null
    this.carry = null
    const blank = (this.deps.blank ?? CPU_BLANK) as C
    // A continued check shows where it stopped until its worker reports.
    const base = (): ScanStatus<C> => ({
      ...(carried ?? blank),
      projectPath,
      state: 'running',
    })
    const mine = () => this.worker === worker
    const update = (next: Partial<ScanCounts> & { state?: ScanState }) => {
      if (!mine()) return
      this.publish({ ...(this.current ?? base()), ...next } as ScanStatus<C>)
    }
    this.publish(base())
    // An import or filter run goes first: pause until it's done.
    this.busyTimer = setInterval(() => {
      const now = this.deps.isBusy()
      if (now === busy || !mine()) return
      busy = now
      worker.postMessage({ type: now ? 'pause' : 'resume' })
      update({ state: now ? 'paused' : 'running' })
    }, this.deps.pollMs ?? 2000)
    worker.on('message', (raw) => {
      if (!mine()) return
      const { type, message, stopped, ...counts } = raw as WorkerMessage
      const shown = withCarry(counts as C, carried)
      if (type === 'progress') {
        update({ ...shown, state: busy ? 'paused' : 'running' })
        return
      }
      if (type === 'done') {
        update({ ...shown, state: stopped ? 'stopped' : 'done' })
        if (!stopped && !counts.missing && !counts.unreachable)
          this.complete.add(projectPath)
        if (counts.checked) this.deps.log(this.name, { projectPath, ...counts })
      } else {
        this.deps.log(`${this.name} failed`, message)
        update({ state: 'failed' })
      }
      this.detach(worker)
    })
    worker.once('error', (error) => {
      if (!mine()) return
      this.deps.log(`${this.name} failed`, error)
      update({ state: 'failed' })
      this.detach(worker)
    })
    worker.once('exit', () => {
      if (mine()) this.detach(worker)
    })
  }

  /** Forget the worker and end it; its termination is waited for by stop(). */
  private detach(worker: ScanWorker) {
    if (this.worker === worker) {
      this.worker = null
      if (this.busyTimer) clearInterval(this.busyTimer)
      this.busyTimer = null
    }
    const ending = worker.terminate().then(
      () => {},
      () => {},
    )
    this.ending.add(ending)
    ending.finally(() => this.ending.delete(ending))
  }

  /**
   * Stop the check. `byUser`: the bar's Stop (shows "Stopped" with Continue and
   * isn't started again this session until Continue). Otherwise the project is
   * closing or changing: the bar is cleared. Resolves once every worker's
   * connection to the project is gone, also for a stop already under way.
   */
  stop(opts: { byUser?: boolean } = {}): Promise<void> {
    const worker = this.worker
    const projectPath = this.current?.projectPath
    if (opts.byUser && projectPath) this.stoppedFor.add(projectPath)
    if (worker) {
      this.detach(worker)
      const active =
        this.current?.state === 'running' || this.current?.state === 'paused'
      if (opts.byUser && active && this.current)
        this.publish({ ...this.current, state: 'stopped' })
      else if (!opts.byUser) this.publish(null)
    } else if (!opts.byUser && this.current) this.publish(null)
    return Promise.all([...this.ending]).then(() => {})
  }

  /** The bar's Continue: start again for this project. */
  continue(projectPath: string | null | undefined) {
    if (!projectPath) return
    this.stoppedFor.delete(projectPath)
    const stopped = this.current
    if (
      !this.worker &&
      stopped?.projectPath === projectPath &&
      stopped.state === 'stopped'
    ) {
      const { projectPath: _p, state: _s, ...counts } = stopped
      this.carry = { projectPath, counts: counts as unknown as C }
    }
    this.start(projectPath)
  }
}
