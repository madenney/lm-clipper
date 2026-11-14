/**
 * @jest-environment node
 *
 * The read lane (main/readLane.ts) with a stand-in worker: requests and replies,
 * newer reads on a lane superseding older ones (the shared counter the worker
 * checks), close, and a worker that dies. The real worker on real SQLite is
 * checked in scripts/worker-check/seek.js.
 */
import { ReadLane, StaleReadError, isStaleRead } from '../main/readLane'

type Msg = Record<string, any>

class FakeWorker {
  posted: Msg[] = []

  handlers: Record<string, ((_arg: any) => void)[]> = {}

  terminated = false

  gens: Int32Array

  constructor(gens: SharedArrayBuffer) {
    this.gens = new Int32Array(gens)
  }

  postMessage(msg: Msg) {
    this.posted.push(msg)
  }

  on(event: string, fn: (_arg: any) => void) {
    ;(this.handlers[event] ||= []).push(fn)
    return this
  }

  emit(event: string, arg?: any) {
    for (const fn of this.handlers[event] || []) fn(arg)
  }

  /** Answer a request the way DbReadWorker does (stale if superseded). */
  answer(msg: Msg, rows: unknown[] = []) {
    const stale =
      msg.slot !== null && Atomics.load(this.gens, msg.slot) !== msg.gen
    this.emit('message', {
      id: msg.id,
      type: 'result',
      data: stale ? { stale: true } : { rows },
    })
  }

  terminate() {
    this.terminated = true
    return Promise.resolve(0)
  }
}

function makeLane() {
  const workers: FakeWorker[] = []
  const lane = new ReadLane((gens) => {
    const w = new FakeWorker(gens)
    workers.push(w)
    return w
  })
  return { lane, workers }
}

describe('ReadLane', () => {
  it('sends a window read and resolves with its rows', async () => {
    const { lane, workers } = makeLane()
    const p = lane.readWindow('/p.lunar', 'combos', 4000, 2000)
    const msg = workers[0].posted[0]
    expect(msg).toMatchObject({
      method: 'readWindow',
      dbPath: '/p.lunar',
      tableId: 'combos',
      offset: 4000,
      limit: 2000,
      slot: null,
    })
    workers[0].answer(msg, [{ id: 1 }])
    await expect(p).resolves.toEqual({ rows: [{ id: 1 }] })
  })

  it('a newer read on the same lane supersedes the older ones', async () => {
    const { lane, workers } = makeLane()
    const w = () => workers[0]
    const first = lane.readWindow('/p', 't', 5_000_000, 2000, 'tray')
    const second = lane.readWindow('/p', 't', 4_000_000, 2000, 'tray')
    const third = lane.readWindow('/p', 't', 10, 2000, 'tray')
    const other = lane.readWindow('/p', 't', 20, 5, 'single')
    const plain = lane.readWindow('/p', 't', 30, 5)
    const [m1, m2, m3, m4, m5] = w().posted
    expect(m1.slot).toBe(m2.slot)
    expect(m4.slot).not.toBe(m1.slot)
    for (const m of [m1, m2, m3, m4, m5]) w().answer(m, [m.offset])
    await expect(first).resolves.toEqual({ stale: true })
    await expect(second).resolves.toEqual({ stale: true })
    await expect(third).resolves.toEqual({ rows: [10] })
    await expect(other).resolves.toEqual({ rows: [20] })
    await expect(plain).resolves.toEqual({ rows: [30] })
  })

  it('rejects on a worker error reply, and when the worker dies', async () => {
    const { lane, workers } = makeLane()
    const a = lane.readWindow('/p', 't', 0, 10)
    workers[0].emit('message', {
      id: workers[0].posted[0].id,
      type: 'error',
      error: 'no such table: t',
    })
    await expect(a).rejects.toThrow('no such table: t')

    const b = lane.readWindow('/p', 't', 0, 10)
    workers[0].emit('error', new Error('crashed'))
    await expect(b).rejects.toThrow('crashed')
    // The next read starts a new worker.
    const c = lane.readWindow('/p', 't', 0, 10)
    expect(workers).toHaveLength(2)
    workers[1].answer(workers[1].posted[0], [])
    await expect(c).resolves.toEqual({ rows: [] })
  })

  it('close stops reads still finding their position, then closes', async () => {
    const { lane, workers } = makeLane()
    await expect(lane.close()).resolves.toBeUndefined() // never started: nothing to do
    expect(workers).toHaveLength(0)

    const read = lane.readWindow('/p', 't', 9_000_000, 2000, 'tray')
    const closing = lane.close()
    const [readMsg, closeMsg] = workers[0].posted
    expect(closeMsg.method).toBe('close')
    workers[0].answer(readMsg)
    await expect(read).resolves.toEqual({ stale: true })
    workers[0].emit('message', { id: closeMsg.id, type: 'result', data: null })
    await expect(closing).resolves.toBeUndefined()
  })

  it('close with a time limit gives up waiting (quitting)', async () => {
    jest.useFakeTimers()
    try {
      const { lane } = makeLane()
      lane.readWindow('/p', 't', 0, 1)
      const closing = lane.close(1500)
      jest.advanceTimersByTime(1500)
      await expect(closing).resolves.toBeUndefined()
    } finally {
      jest.useRealTimers()
    }
  })

  it('terminate rejects what is pending and stops the worker', async () => {
    const { lane, workers } = makeLane()
    const a = lane.readWindow('/p', 't', 0, 10, 'tray')
    lane.terminate()
    expect(workers[0].terminated).toBe(true)
    await expect(a).rejects.toThrow('terminated')
  })

  it('isStaleRead recognises the superseded error', () => {
    expect(isStaleRead(new StaleReadError())).toBe(true)
    expect(isStaleRead(new Error('other'))).toBe(false)
    expect(isStaleRead(null)).toBe(false)
  })
})
