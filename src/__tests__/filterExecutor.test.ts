/**
 * @jest-environment node
 *
 * FilterExecutor run bookkeeping: the paths behind "click Run twice", stale
 * results marked done, failed runs marked done, and edits racing a run.
 * Filter.run3 and the database are faked; each test finishes, fails or aborts
 * a run on cue.
 */
type RunArgs = [string, string, number, Function, AbortSignal, any?]
type RunResult = {
  terminated: boolean
  failed?: boolean
  errors: string[]
  durationMs?: number
}

const runs: {
  args: RunArgs
  resolve: (_r: RunResult) => void
}[] = []

jest.mock('electron', () => ({}))
jest.mock('../main/telemetry', () => ({ track: jest.fn() }))

jest.mock('../models/Filter', () => ({
  __esModule: true,
  default: class FakeFilter {
    constructor(json: any) {
      Object.assign(this, json)
    }

    run3(...args: RunArgs): Promise<RunResult> {
      return new Promise((resolve) => {
        runs.push({ args, resolve })
      })
    }
  },
}))

// The "database": the saved filter list.
let saved: any[] = []
const clone = (x: any) => JSON.parse(JSON.stringify(x))
const resetFiltersFrom = jest.fn(async () => {})

jest.mock('../models/Archive', () => ({
  __esModule: true,
  default: class FakeArchive {
    filters: any[] = []

    resetFiltersFrom: any

    saveMetaData: any

    constructor(meta: any) {
      Object.assign(this, clone(meta))
      this.resetFiltersFrom = resetFiltersFrom
      this.saveMetaData = async () => {
        saved = clone(this.filters)
      }
    }
  },
}))

jest.mock('../main/dbAsync', () => ({
  getMetaData: async (path: string) => ({
    path,
    name: 'p',
    files: 10,
    filters: clone(saved),
  }),
  getTableCountAsync: async () => 5,
  deleteFilterRunAsync: async () => {},
  updateFilterRunProgressAsync: async () => {},
}))

// eslint-disable-next-line import/first
import FilterExecutor from '../main/managers/FilterExecutor'
// eslint-disable-next-line import/first
import Archive from '../models/Archive'

const flush = () =>
  new Promise((resolve) => {
    setImmediate(resolve)
  })

let archive: any
let executor: FilterExecutor
let consoleLogs: string[]
let testConfig: any
const event = { reply: jest.fn() } as any

beforeEach(() => {
  runs.length = 0
  event.reply.mockClear()
  resetFiltersFrom.mockClear()
  consoleLogs = []
  testConfig = { numFilterThreads: 1, branchingEnabled: false }
  saved = [
    { id: 'filter_0', type: 'files', params: {}, isProcessed: true },
    {
      id: 'filter_1',
      type: 'comboFilter',
      label: 'Combo Filter',
      params: { minHits: '4' },
      isProcessed: false,
    },
  ]
  archive = new (Archive as any)({ path: '/p.lunar', filters: saved })
  executor = new FilterExecutor(
    {
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send: jest.fn() },
    } as any,
    {
      getArchive: () => archive,
      setArchive: (a: any) => {
        archive = a
      },
      getConfig: () => testConfig,
      consoleManager: {
        startConsole: jest.fn(),
        stopConsole: jest.fn(),
        pushConsoleLog: (_l: string, m: string) => consoleLogs.push(m),
      } as any,
    },
  )
})

// Wrapped in an object: returning the promise itself from an async function
// would make `await startRun()` wait for the whole run.
async function startRun(requestId = 'r1') {
  const done = executor.runFilter(event, { requestId, payload: 'filter_1' })
  await flush()
  return { done }
}

const savedFilter = () => saved.find((f) => f.id === 'filter_1')

describe('custom code consent is enforced in main (SEC-1)', () => {
  const code = 'return clips'
  const sha = (text: string) =>
    // eslint-disable-next-line global-require
    require('crypto').createHash('sha256').update(text, 'utf8').digest('hex')

  beforeEach(() => {
    saved[1] = {
      id: 'filter_1',
      type: 'aiFilter',
      label: 'AI Filter',
      params: { code },
      isProcessed: false,
    } as any
    archive.filters[1] = JSON.parse(JSON.stringify(saved[1]))
  })

  it('refuses to run code the user has not approved', async () => {
    await executor.runFilter(event, { requestId: 'c1', payload: 'filter_1' })
    expect(runs).toHaveLength(0)
    const reply = event.reply.mock.calls.find(
      (c: any[]) => c[0] === 'runFilter',
    )
    expect(reply[1].payload.error).toMatch(/not approved/)
    expect(executor.isRunning('filter_1')).toBe(false)
  })

  it('refuses a resume the same way', async () => {
    await executor.resumeFilter(event, { requestId: 'c2', payload: 'filter_1' })
    expect(runs).toHaveLength(0)
    const reply = event.reply.mock.calls.find(
      (c: any[]) => c[0] === 'resumeFilter',
    )
    expect(reply[1].payload.error).toMatch(/not approved/)
  })

  it('runs code whose hash was approved, and refuses it again once edited', async () => {
    testConfig.approvedCustomCodeHashes = [sha(code)]
    const { done } = await startRun('c3')
    expect(runs).toHaveLength(1)
    runs[0].resolve({ terminated: false, errors: [] })
    await done
    archive.filters[1].params = { code: `${code} // edited` }
    await executor.runFilter(event, { requestId: 'c4', payload: 'filter_1' })
    expect(runs).toHaveLength(1)
  })

  it('runs a built-in template as shipped', async () => {
    testConfig.savedCustomFilters = [{ name: 'T', code, builtIn: true }]
    const { done } = await startRun('c5')
    expect(runs).toHaveLength(1)
    runs[0].resolve({ terminated: false, errors: [] })
    await done
  })

  it('a step with no custom code is not gated', async () => {
    saved[1] = {
      id: 'filter_1',
      type: 'comboFilter',
      params: { minHits: '4' },
      isProcessed: false,
    } as any
    archive.filters[1] = JSON.parse(JSON.stringify(saved[1]))
    const { done } = await startRun('c6')
    expect(runs).toHaveLength(1)
    runs[0].resolve({ terminated: false, errors: [] })
    await done
  })
})

describe('FilterExecutor', () => {
  it('marks a normally finished run processed and replies', async () => {
    const { done } = await startRun()
    expect(executor.isRunning('filter_1')).toBe(true)
    runs[0].resolve({ terminated: false, errors: [], durationMs: 12 })
    await done
    expect(savedFilter().isProcessed).toBe(true)
    expect(executor.isRunning('filter_1')).toBe(false)
    expect(event.reply).toHaveBeenCalledWith(
      'runFilter',
      expect.objectContaining({ requestId: 'r1' }),
    )
  })

  it('does not mark results done if the params changed during the run', async () => {
    const { done } = await startRun()
    // An edit saved while the run was going.
    saved[1].params = { minHits: '6' }
    runs[0].resolve({ terminated: false, errors: [] })
    await done
    expect(savedFilter().isProcessed).toBeFalsy()
    expect(consoleLogs.join('\n')).toMatch(/settings changed during the run/)
  })

  it('does not mark a run done when a worker failed', async () => {
    const { done } = await startRun()
    runs[0].resolve({ terminated: false, errors: ['worker exited 1'] })
    await done
    expect(savedFilter().isProcessed).toBeFalsy()
    const reply = event.reply.mock.calls.find(
      (c: any[]) => c[0] === 'runFilter',
    )
    expect(reply[1].payload.filterMessage.filter_1).toMatch(/Run failed/)
  })

  it('a run that skipped unreadable games finishes done, with a note', async () => {
    const { done } = await startRun()
    runs[0].resolve({
      terminated: false,
      errors: [],
      corrupt: 10,
      examples: ['/games/bad.slp'],
    } as any)
    await done
    expect(savedFilter().isProcessed).toBe(true)
    const reply = event.reply.mock.calls.find(
      (c: any[]) => c[0] === 'runFilter',
    )
    expect(reply[1].payload.filterMessage.filter_1).toMatch(/10 games skipped/)
    expect(reply[1].payload.filterMessage.filter_1).not.toMatch(/failed/i)
    expect(consoleLogs.join('\n')).toMatch(/10 unreadable — skipped/)
  })

  it('Keep results marks a failed run done without touching other steps', async () => {
    // A run that failed partway: results kept, never marked done.
    saved[1].isProcessed = false
    saved[1].resumable = true
    saved[1].resumeProgress = { processed: 264764, totalInput: 264764 }
    const before = JSON.parse(JSON.stringify(saved))
    await executor.keepFilterResults(event, {
      requestId: 'k1',
      payload: 'filter_1',
    })
    expect(savedFilter().isProcessed).toBe(true)
    expect(savedFilter().results).toBe(5)
    expect(saved[0]).toEqual(before[0])
    const reply = event.reply.mock.calls.find(
      (c: any[]) => c[0] === 'keepFilterResults',
    )
    expect(reply[1].requestId).toBe('k1')
    expect(consoleLogs.join('\n')).toMatch(
      /kept 5 results \(stopped at 264,764 of 264,764\)/,
    )
  })

  it('Keep results refuses while the step is running', async () => {
    await startRun()
    await executor.keepFilterResults(event, {
      requestId: 'k2',
      payload: 'filter_1',
    })
    const reply = event.reply.mock.calls.find(
      (c: any[]) => c[0] === 'keepFilterResults',
    )
    expect(reply[1].payload.error).toMatch(/still running/)
    expect(savedFilter().isProcessed).toBeFalsy()
  })

  it('does not mark a failed resume done', async () => {
    const done = executor.resumeFilter(event, {
      requestId: 'r2',
      payload: 'filter_1',
    })
    await flush()
    runs[0].resolve({
      terminated: false,
      failed: true,
      errors: ['Resume failed: x'],
    })
    await done
    expect(savedFilter().isProcessed).toBeFalsy()
  })

  it('restarting waits for the old run to finish, then runs alone', async () => {
    const { done: first } = await startRun('a')
    const { done: second } = await startRun('b')
    // Starting the second stopped the first, but didn't start a second run
    // on the same table while the first is still winding down.
    expect(runs[0].args[4].aborted).toBe(true)
    expect(runs).toHaveLength(1)
    runs[0].resolve({ terminated: true, errors: [] })
    await first
    await flush()
    await flush()
    expect(runs).toHaveLength(2)
    expect(executor.isRunning('filter_1')).toBe(true)
    expect(executor.runningFilterControllers.get('filter_1')).toBeDefined()
    runs[1].resolve({ terminated: false, errors: [] })
    await second
    expect(savedFilter().isProcessed).toBe(true)
    expect(executor.isRunning('filter_1')).toBe(false)
  })

  it('stopAndWait cancels a run and resolves only after it has finished', async () => {
    const { done } = await startRun()
    const signal = runs[0].args[4]
    let stopped = false
    const stop = executor.stopAndWait(['filter_1']).then(() => {
      stopped = true
    })
    expect(signal.aborted).toBe(true)
    await flush()
    expect(stopped).toBe(false) // still waiting on the run's cleanup
    runs[0].resolve({ terminated: true, errors: [] })
    await Promise.all([done, stop])
    expect(stopped).toBe(true)
    expect(executor.isRunning('filter_1')).toBe(false)
    // Cancel resets from the CURRENT project, found by id.
    expect(resetFiltersFrom).toHaveBeenCalledWith(1, false)
  })

  it('stopAndWait returns at once when nothing is running', async () => {
    await expect(executor.stopAndWait(['filter_1'])).resolves.toBeUndefined()
  })

  it('Stop keeps the run tracked until it has finished, then saves its progress', async () => {
    const progress = jest.requireMock('../main/dbAsync')
    const saveProgress = jest
      .spyOn(progress, 'updateFilterRunProgressAsync')
      .mockResolvedValue(undefined)
    const { done } = await startRun()
    await executor.stopFilter(event, { requestId: 's', payload: 'filter_1' })
    expect(runs[0].args[4].aborted).toBe(true)
    // Still tracked (shown as stopping) while the workers wind down.
    expect(executor.isRunning('filter_1')).toBe(true)
    expect(executor.stoppingIds.has('filter_1')).toBe(true)
    runs[0].resolve({
      terminated: true,
      errors: [],
      lastProgress: 7,
    } as any)
    await done
    expect(executor.isRunning('filter_1')).toBe(false)
    expect(executor.stoppingIds.has('filter_1')).toBe(false)
    // Its resume point and partial count were saved (not skipped as if a
    // newer run had replaced it).
    expect(saveProgress).toHaveBeenCalledWith('/p.lunar', 'filter_1', 7)
    expect(savedFilter().results).toBe(5)
    expect(savedFilter().isProcessed).toBeFalsy()
    saveProgress.mockRestore()
  })

  it('a run that throws still replies and is no longer shown running', async () => {
    const { done } = await startRun()
    // e.g. the database failing after the workers finished
    const db = jest.requireMock('../main/dbAsync')
    const count = jest
      .spyOn(db, 'getTableCountAsync')
      .mockRejectedValue(new Error('disk I/O error'))
    const del = jest
      .spyOn(db, 'deleteFilterRunAsync')
      .mockRejectedValue(new Error('disk I/O error'))
    runs[0].resolve({ terminated: false, errors: [] })
    await done
    expect(executor.isRunning('filter_1')).toBe(false)
    const reply = event.reply.mock.calls.find(
      (c: any[]) => c[0] === 'runFilter',
    )
    expect(reply).toBeDefined()
    expect(reply[1].payload.filterMessage.filter_1).toMatch(/Run failed/)
    expect(savedFilter().isProcessed).toBeFalsy()
    count.mockRestore()
    del.mockRestore()
  })

  it('a run whose model throws before starting still replies', async () => {
    const FakeFilter = jest.requireMock('../models/Filter').default
    const run3 = jest
      .spyOn(FakeFilter.prototype, 'run3')
      .mockRejectedValueOnce(new Error('no such table'))
    await executor.runFilter(event, { requestId: 'x', payload: 'filter_1' })
    expect(executor.isRunning('filter_1')).toBe(false)
    expect(
      event.reply.mock.calls.some((c: any[]) => c[0] === 'runFilter'),
    ).toBe(true)
    run3.mockRestore()
  })
})
