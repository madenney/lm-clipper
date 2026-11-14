/**
 * @jest-environment node
 *
 * DbWorker dispatch for the main-process calls moved off the main thread
 * ('callSync', 'closeDb'). better-sqlite3 is built for Electron's ABI, so the
 * real queries are covered by the manual test list, not here.
 */
let onMessage: ((_msg: any) => void) | null = null
const posted: any[] = []

jest.mock('worker_threads', () => ({
  parentPort: {
    on: (_event: string, fn: (_msg: any) => void) => {
      onMessage = fn
    },
    postMessage: (msg: any) => posted.push(msg),
  },
}))

jest.mock('better-sqlite3', () => jest.fn())

const closeDb = jest.fn()
jest.mock('../main/dbConnection', () => ({
  getDb: jest.fn(() => ({})),
  closeDb: () => closeDb(),
}))

const createFilter = jest.fn((..._a: any[]) => undefined)
const getFileByPath = jest.fn((..._a: any[]) => ({ id: 7, path: '/a.slp' }))
jest.mock('../main/db', () => ({
  WORKER_SYNC_FNS: {
    createFilter: (...a: any[]) => createFilter(...a),
    getFileByPath: (...a: any[]) => getFileByPath(...a),
  },
}))

const libraryLookup = jest.fn((..._a: any[]) => ({ have: {}, missing: [] }))
const closeLibraries = jest.fn()
jest.mock('../main/replayLibrary', () => ({
  LIBRARY_FNS: { libraryLookup: (...a: any[]) => libraryLookup(...a) },
  closeLibraries: () => closeLibraries(),
}))

// eslint-disable-next-line import/first
import '../main/DbWorker'

function send(msg: any) {
  posted.length = 0
  onMessage!(msg)
  return posted[0]
}

describe('DbWorker', () => {
  it('runs an allowlisted db.ts function and returns its result', () => {
    const res = send({
      id: 1,
      dbPath: '/p.lunar',
      method: 'callSync',
      fn: 'getFileByPath',
      args: ['/p.lunar', '/a.slp'],
    })
    expect(getFileByPath).toHaveBeenCalledWith('/p.lunar', '/a.slp')
    expect(res).toEqual({
      id: 1,
      type: 'result',
      data: { id: 7, path: '/a.slp' },
    })
  })

  it('refuses functions that are not on the allowlist', () => {
    const res = send({
      id: 2,
      dbPath: '/p.lunar',
      method: 'callSync',
      fn: 'dropEverything',
      args: [],
    })
    expect(res.type).toBe('error')
    expect(res.error).toMatch(/Unknown sync function/)
  })

  it('reports errors thrown by the function', () => {
    createFilter.mockImplementationOnce(() => {
      throw new Error('database is locked')
    })
    const res = send({
      id: 3,
      dbPath: '/p.lunar',
      method: 'callSync',
      fn: 'createFilter',
      args: ['/p.lunar', 'filter_1'],
    })
    expect(res).toEqual({ id: 3, type: 'error', error: 'database is locked' })
  })

  it('closes (checkpoints) its connection on closeDb and on shutdown', () => {
    closeDb.mockClear()
    expect(send({ id: 4, dbPath: '', method: 'closeDb' })).toEqual({
      id: 4,
      type: 'result',
      data: null,
    })
    expect(closeDb).toHaveBeenCalledTimes(1)
    expect(send({ id: -1, __control: 'close' })).toEqual({
      id: -1,
      type: 'closed',
    })
    expect(closeDb).toHaveBeenCalledTimes(2)
    expect(closeLibraries).toHaveBeenCalledTimes(1)
  })

  it('runs replay-library functions without touching the project connection', () => {
    const res = send({
      id: 5,
      dbPath: '',
      method: 'library',
      fn: 'libraryLookup',
      args: ['/Library', ['a'.repeat(24)]],
    })
    expect(libraryLookup).toHaveBeenCalledWith('/Library', ['a'.repeat(24)])
    expect(res).toEqual({
      id: 5,
      type: 'result',
      data: { have: {}, missing: [] },
    })
    expect(
      send({
        id: 6,
        dbPath: '',
        method: 'library',
        fn: 'dropEverything',
        args: [],
      }).error,
    ).toMatch(/Unknown library function/)
  })
})
