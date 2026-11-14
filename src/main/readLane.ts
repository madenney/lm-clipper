/**
 * The read lane (docs/tray-v2.md): a second DB worker (DbReadWorker.ts) with its own
 * read-only connection, for the tray's quick window reads. They never wait behind
 * the main DB worker's writes, overview chunks or full-table counts, and never run
 * on the Electron main thread. dbAsync.ts runs a second lane for slow background
 * reads (selection lengths, warming the overview cache), so those never hold up
 * either the windows or DbWorker.
 *
 * A request can name a lane (the tray's window is one). A newer request on the same
 * lane supersedes the older ones: one that hasn't started is skipped, one still
 * finding its position stops (a shared generation counter the worker checks), and
 * both answer `{ stale: true }`.
 */
export type ReadReply = { rows: unknown[] } | { stale: true }

export interface ReadWorker {
  postMessage(_msg: unknown): void
  on(_event: 'message' | 'error' | 'exit', _fn: (_arg: any) => void): unknown
  terminate(): Promise<number> | void
}

/** Lanes that can be superseded (each one has a slot in the shared counters). */
export const MAX_LANES = 16

export class StaleReadError extends Error {
  constructor() {
    super('Superseded by a newer read')
    this.name = 'StaleReadError'
  }
}

export const isStaleRead = (err: unknown) =>
  err instanceof StaleReadError ||
  (err instanceof Error && err.name === 'StaleReadError')

export class ReadLane {
  private worker: ReadWorker | null = null

  private nextId = 0

  private pending = new Map<
    number,
    { resolve: (_data: any) => void; reject: (_err: Error) => void }
  >()

  /** One generation counter per lane, shared with the worker. */
  readonly gens = new Int32Array(new SharedArrayBuffer(4 * MAX_LANES))

  private slots = new Map<string, number>()

  private spawn: (_gens: SharedArrayBuffer) => ReadWorker

  constructor(spawn: (_gens: SharedArrayBuffer) => ReadWorker) {
    this.spawn = spawn
  }

  private getWorker(): ReadWorker {
    if (this.worker) return this.worker
    const w = this.spawn(this.gens.buffer as SharedArrayBuffer)
    const fail = (err: Error) => {
      if (this.worker === w) this.worker = null
      for (const [, p] of this.pending) p.reject(err)
      this.pending.clear()
    }
    w.on(
      'message',
      (msg: { id: number; type: string; data?: any; error?: string }) => {
        const p = this.pending.get(msg.id)
        if (!p) return
        this.pending.delete(msg.id)
        if (msg.type === 'result') p.resolve(msg.data)
        else p.reject(new Error(msg.error || 'DbReadWorker error'))
      },
    )
    w.on('error', (err: Error) => fail(err))
    w.on('exit', () => fail(new Error('DbReadWorker exited')))
    this.worker = w
    return w
  }

  private call(msg: Record<string, unknown>): Promise<any> {
    return new Promise((resolve, reject) => {
      this.nextId += 1
      const id = this.nextId
      this.pending.set(id, { resolve, reject })
      try {
        this.getWorker().postMessage({ id, ...msg })
      } catch (err) {
        this.pending.delete(id)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  private slot(lane: string): number | null {
    let s = this.slots.get(lane)
    if (s === undefined) {
      if (this.slots.size >= MAX_LANES) return null
      s = this.slots.size
      this.slots.set(lane, s)
    }
    return s
  }

  /** The rows the old `LIMIT limit OFFSET offset` query returned (rowSeek.ts). */
  readWindow(
    dbPath: string,
    tableId: string,
    offset: number,
    limit: number,
    lane?: string,
  ): Promise<ReadReply> {
    return this.query('readWindow', { dbPath, tableId, offset, limit }, lane)
  }

  /**
   * Any other read DbReadWorker knows (`method`). On a lane, a newer request
   * supersedes this one; one that hasn't started answers `{ stale: true }`.
   */
  query(
    method: string,
    args: Record<string, unknown>,
    lane?: string,
  ): Promise<any> {
    const slot = lane ? this.slot(lane) : null
    // Bumping the lane's counter is what tells older requests to give up.
    const gen = slot === null ? 0 : Atomics.add(this.gens, slot, 1) + 1
    return this.call({ method, ...args, slot, gen })
  }

  /** Stop whatever is still finding its position (closing, terminating). */
  private supersedeAll() {
    for (const s of this.slots.values()) Atomics.add(this.gens, s, 1)
  }

  /**
   * Close the read connection (before the project file is copied, moved or
   * closed); the next read opens it again. Reads still finding their position stop
   * (they answer `stale`). `timeoutMs` bounds the wait (quitting); without it this
   * waits for the close, since nothing may hold the file open afterwards.
   */
  close(timeoutMs?: number): Promise<void> {
    if (!this.worker) return Promise.resolve()
    this.supersedeAll()
    const closed = this.call({ method: 'close' }).then(
      () => {},
      () => {},
    )
    if (timeoutMs === undefined) return closed
    return Promise.race([
      closed,
      new Promise<void>((resolve) => {
        setTimeout(resolve, timeoutMs)
      }),
    ])
  }

  terminate() {
    const w = this.worker
    this.worker = null
    if (w) {
      this.supersedeAll()
      Promise.resolve(w.terminate()).catch(() => {})
    }
    for (const [, p] of this.pending)
      p.reject(new Error('DbReadWorker terminated'))
    this.pending.clear()
  }
}
