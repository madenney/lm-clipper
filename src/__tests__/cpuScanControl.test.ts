import { EventEmitter } from 'events'
import CpuScanControl, {
  type ScanWorker,
  withCarry,
} from '../main/cpuScanControl'
import type { CpuScanStatus } from '../lib/cpuPlayers'

/** A worker whose termination finishes only when the test says so. */
class FakeWorker extends EventEmitter implements ScanWorker {
  posted: unknown[] = []

  terminations = 0

  private finish: (() => void) | null = null

  private ended: Promise<number> | null = null

  postMessage(message: unknown) {
    this.posted.push(message)
  }

  terminate() {
    this.terminations += 1
    if (!this.ended)
      this.ended = new Promise<number>((resolve) => {
        this.finish = () => resolve(1)
      })
    return this.ended
  }

  /** The thread is gone (and with it its connection to the project). */
  end() {
    this.finish?.()
  }
}

function setup() {
  const workers: FakeWorker[] = []
  const published: (CpuScanStatus | null)[] = []
  let busy = false
  const control = new CpuScanControl({
    spawn: () => {
      const w = new FakeWorker()
      workers.push(w)
      return w
    },
    isBusy: () => busy,
    publish: (s) => published.push(s),
    log: () => {},
    pollMs: 10,
  })
  return {
    control,
    workers,
    published,
    setBusy: (b: boolean) => {
      busy = b
    },
  }
}

const flush = () =>
  new Promise((resolve) => {
    setTimeout(resolve, 5)
  })

describe('the background CPU check', () => {
  it('waits for the worker to be gone before a project closes, also on a second stop', async () => {
    const { control, workers } = setup()
    control.start('/p.lunar')
    // Closing a project stops early and awaits later (closeArchive, compaction):
    // the awaited stop must still wait for the first one's worker.
    control.stop()
    let closed = false
    const waited = control.stop().then(() => {
      closed = true
    })
    await flush()
    expect(closed).toBe(false)
    workers[0].end()
    await waited
    expect(closed).toBe(true)
  })

  it('a project closing clears the bar; the user stopping shows Continue', async () => {
    const { control, workers, published } = setup()
    control.start('/p.lunar')
    const closing = control.stop()
    workers[0].end()
    await closing
    expect(published[published.length - 1]).toBeNull()

    control.start('/p.lunar')
    const stopping = control.stop({ byUser: true })
    workers[1].end()
    await stopping
    expect(control.status?.state).toBe('stopped')
    // Not started again this session (a reopen, a download finishing) ...
    control.start('/p.lunar')
    expect(workers).toHaveLength(2)
    // ... until Continue.
    control.continue('/p.lunar')
    expect(workers).toHaveLength(3)
  })

  it('leaves a running check alone when the same project asks again', () => {
    const { control, workers } = setup()
    control.start('/p.lunar')
    control.start('/p.lunar')
    expect(workers).toHaveLength(1)
    expect(workers[0].terminations).toBe(0)
  })

  it('pauses while an import or filter runs and resumes after', async () => {
    const { control, workers, setBusy } = setup()
    control.start('/p.lunar')
    setBusy(true)
    await new Promise((resolve) => {
      setTimeout(resolve, 30)
    })
    expect(workers[0].posted).toContainEqual({ type: 'pause' })
    expect(control.status?.state).toBe('paused')
    setBusy(false)
    await new Promise((resolve) => {
      setTimeout(resolve, 30)
    })
    expect(workers[0].posted).toContainEqual({ type: 'resume' })
    expect(control.status?.state).toBe('running')
    const stopping = control.stop()
    workers[0].end()
    await stopping
  })

  it('a finished check is not run again; one with replays out of reach is', async () => {
    const { control, workers } = setup()
    const counts = {
      total: 3,
      checked: 3,
      cpuGames: 1,
      missing: 0,
      unreadable: 0,
    }
    control.start('/done.lunar')
    workers[0].emit('message', { type: 'done', ...counts })
    workers[0].end()
    expect(control.status).toMatchObject({ state: 'done', cpuGames: 1 })
    control.start('/done.lunar')
    expect(workers).toHaveLength(1)

    control.start('/away.lunar')
    workers[1].emit('message', { type: 'done', ...counts, missing: 2 })
    workers[1].end()
    control.start('/away.lunar')
    expect(workers).toHaveLength(3)
    const stopping = control.stop()
    workers[2].end()
    await stopping
  })

  it('reports only on the open project', () => {
    const { control, workers } = setup()
    control.start('/a.lunar')
    expect(control.statusFor('/a.lunar')?.projectPath).toBe('/a.lunar')
    expect(control.statusFor('/b.lunar')).toBeNull()
    const stopping = control.stop()
    workers[0].end()
    return stopping
  })
})

describe('the same control for the game length repair', () => {
  it('starts from its own counts and keeps what its worker reports', () => {
    const workers: FakeWorker[] = []
    const published: unknown[] = []
    const logged: string[] = []
    const blank = {
      total: 0,
      checked: 0,
      repaired: 0,
      missing: 0,
      unreadable: 0,
      resultsRows: 0,
    }
    const control = new CpuScanControl<typeof blank>({
      spawn: () => {
        const w = new FakeWorker()
        workers.push(w)
        return w
      },
      isBusy: () => false,
      publish: (s) => published.push(s),
      log: (message) => logged.push(message),
      blank,
      name: 'game length scan',
      pollMs: 10,
    })
    control.start('/p.lunar')
    expect(published[0]).toEqual({
      ...blank,
      projectPath: '/p.lunar',
      state: 'running',
    })
    expect(published[0]).not.toHaveProperty('cpuGames')
    workers[0].emit('message', {
      type: 'done',
      ...blank,
      total: 5,
      checked: 5,
      repaired: 4,
      unreadable: 1,
      resultsRows: 9,
    })
    workers[0].end()
    expect(control.status).toMatchObject({
      state: 'done',
      repaired: 4,
      resultsRows: 9,
    })
    expect(logged).toEqual(['game length scan'])
    // Done with nothing missing: not run again this session.
    control.start('/p.lunar')
    expect(workers).toHaveLength(1)
  })

  it('Continue keeps counting against the original total', async () => {
    const workers: FakeWorker[] = []
    const blank = {
      total: 0,
      checked: 0,
      repaired: 0,
      missing: 0,
      unreadable: 0,
      resultsRows: 0,
    }
    const control = new CpuScanControl<typeof blank>({
      spawn: () => {
        const w = new FakeWorker()
        workers.push(w)
        return w
      },
      isBusy: () => false,
      publish: () => {},
      log: () => {},
      blank,
      pollMs: 10,
    })
    control.start('/p.lunar')
    // 1,200 of 63,336 looked at (10 of them out of reach), then Stop.
    workers[0].emit('message', {
      type: 'progress',
      ...blank,
      total: 63336,
      checked: 1200,
      repaired: 1180,
      missing: 10,
      unreadable: 10,
    })
    const stopping = control.stop({ byUser: true })
    workers[0].end()
    await stopping
    expect(control.status).toMatchObject({
      state: 'stopped',
      total: 63336,
      checked: 1200,
    })

    control.continue('/p.lunar')
    // Until the new worker reports, the bar shows where it stopped.
    expect(control.status).toMatchObject({
      state: 'running',
      total: 63336,
      checked: 1200,
    })
    // The new worker counts what's left: the 62,136 never looked at plus the
    // 10 out of reach, which it tries again.
    workers[1].emit('message', {
      type: 'progress',
      ...blank,
      total: 62146,
      checked: 200,
      repaired: 195,
      missing: 5,
    })
    expect(control.status).toMatchObject({
      state: 'running',
      total: 63336,
      checked: 1390,
      repaired: 1375,
      unreadable: 10,
      missing: 5,
    })

    // Stopped and continued again: still the original total.
    const again = control.stop({ byUser: true })
    workers[1].end()
    await again
    control.continue('/p.lunar')
    workers[2].emit('message', {
      type: 'done',
      ...blank,
      total: 61951,
      checked: 61951,
      repaired: 61951,
    })
    expect(control.status).toMatchObject({
      state: 'done',
      total: 63336,
      checked: 63336,
    })

    // A fresh start (not a Continue) counts from zero.
    expect(withCarry({ ...blank, total: 7, checked: 1 }, null)).toEqual({
      ...blank,
      total: 7,
      checked: 1,
    })
  })
})
