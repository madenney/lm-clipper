/**
 * @jest-environment node
 *
 * DbReadWorker's dispatch (the read lane's worker): a read-only connection, reads
 * skipped or stopped once superseded, close. better-sqlite3 is built for
 * Electron's ABI; the real reads are checked in scripts/worker-check/seek.js.
 */
let onMessage: ((_msg: any) => void) | null = null
const posted: any[] = []
const gens = new Int32Array(new SharedArrayBuffer(4 * 16))

jest.mock('worker_threads', () => ({
  parentPort: {
    on: (_event: string, fn: (_msg: any) => void) => {
      onMessage = fn
    },
    postMessage: (msg: any) => posted.push(msg),
  },
  workerData: { gens: gens.buffer },
}))

const opened: any[] = []
const closeConn = jest.fn()
const sql: string[] = []
jest.mock('better-sqlite3', () =>
  jest.fn((path: string, opts: any) => {
    const conn = {
      path,
      opts,
      pragma: jest.fn(),
      close: closeConn,
      // PRAGMA table_info: a results table (JSON); the SUM: 1234 frames.
      prepare: (q: string) => {
        sql.push(q)
        return {
          all: () => [{ name: 'id' }, { name: 'JSON' }],
          get: () => ({ total: 1234 }),
        }
      },
    }
    opened.push(conn)
    return conn
  }),
)

const overviewChunk = jest.fn((..._a: any[]) => ({ ids: [1], next: null }))
jest.mock('../main/overview', () => ({
  readOverviewChunk: (...a: any[]) => overviewChunk(...a),
  readOverviewSignature: () => 'sig',
}))
const selectionFrames = jest.fn((..._a: any[]) => ({ frames: 9, count: 3 }))
jest.mock('../main/selectionSql', () => ({
  ...jest.requireActual('../main/selectionSql'),
  selectionFrames: (...a: any[]) => selectionFrames(...a),
}))

const readWindow = jest.fn((..._a: any[]): unknown[] | null => [{ id: 1 }])
const clearCache = jest.fn()
jest.mock('../main/rowSeek', () => ({
  readWindow: (...a: any[]) => readWindow(...a),
  WindowCache: jest.fn(() => ({ clear: clearCache })),
}))

// eslint-disable-next-line import/first
import '../main/DbReadWorker'

function send(msg: any) {
  posted.length = 0
  onMessage!(msg)
  return posted[0]
}

const read = (extra: any = {}) => ({
  id: 1,
  method: 'readWindow',
  dbPath: '/p.lunar',
  tableId: 'combos',
  offset: 5000,
  limit: 2000,
  slot: null,
  gen: 0,
  ...extra,
})

describe('DbReadWorker', () => {
  beforeEach(() => {
    readWindow.mockClear()
    gens.fill(0)
  })

  it('opens the project read-only (never creating it) and reads a window', () => {
    expect(send(read())).toEqual({
      id: 1,
      type: 'result',
      data: { rows: [{ id: 1 }] },
    })
    expect(opened[0].opts).toEqual({ readonly: true, fileMustExist: true })
    expect(readWindow.mock.calls[0].slice(2, 5)).toEqual(['combos', 5000, 2000])
    send(read({ id: 2 }))
    expect(opened).toHaveLength(1) // the connection is kept
  })

  it('skips a read superseded before it starts', () => {
    Atomics.store(gens, 3, 2) // a newer read on lane 3 was asked for
    expect(send(read({ slot: 3, gen: 1 })).data).toEqual({ stale: true })
    expect(readWindow).not.toHaveBeenCalled()
  })

  it('passes a stop check that turns true once superseded', () => {
    Atomics.store(gens, 3, 1)
    readWindow.mockImplementationOnce((...a: any[]) => {
      const stop = a[5] as () => boolean
      expect(stop()).toBe(false)
      Atomics.store(gens, 3, 2)
      expect(stop()).toBe(true)
      return null
    })
    expect(send(read({ slot: 3, gen: 1 })).data).toEqual({ stale: true })
  })

  it('replies with an error when a read fails', () => {
    readWindow.mockImplementationOnce(() => {
      throw new Error('no such table: combos')
    })
    expect(send(read())).toEqual({
      id: 1,
      type: 'error',
      error: 'no such table: combos',
    })
  })

  it("runs the background lane's slow reads on the read-only connection", () => {
    sql.length = 0
    const slow = (method: string, extra: any = {}) =>
      send({
        id: 5,
        method,
        dbPath: '/p.lunar',
        tableId: 'combos',
        slot: null,
        gen: 0,
        ...extra,
      })
    expect(slow('tableDuration').data).toBe(1234)
    expect(sql.some((q) => q.startsWith('SELECT SUM('))).toBe(true)
    const selection = {
      all: false,
      total: 0,
      keys: [],
      words: new Uint32Array(0),
    }
    expect(slow('selectionFrames', { selection }).data).toEqual({
      frames: 9,
      count: 3,
    })
    expect(slow('overviewSignature').data).toBe('sig')
    expect(slow('overviewChunk', { cursor: null, limit: 10 }).data).toEqual({
      ids: [1],
      next: null,
    })
    expect(overviewChunk.mock.calls[0].slice(1)).toEqual(['combos', null, 10])
    expect(opened.every((c) => c.opts.readonly)).toBe(true)
  })

  it('skips a slow read superseded before it starts (a newer length)', () => {
    Atomics.store(gens, 2, 5)
    sql.length = 0
    const reply = send({
      id: 6,
      method: 'tableDuration',
      dbPath: '/p.lunar',
      tableId: 'combos',
      slot: 2,
      gen: 4,
    })
    expect(reply.data).toEqual({ stale: true })
    expect(sql).toHaveLength(0)
  })

  it('close lets go of the connection; the next read reopens it', () => {
    send(read())
    const before = opened.length
    expect(send({ id: 9, method: 'close' })).toEqual({
      id: 9,
      type: 'result',
      data: null,
    })
    expect(closeConn).toHaveBeenCalled()
    expect(clearCache).toHaveBeenCalled()
    send(read())
    expect(opened).toHaveLength(before + 1)
  })
})
