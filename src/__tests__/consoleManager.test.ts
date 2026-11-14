import ConsoleManager from '../main/managers/ConsoleManager'
import {
  consoleText,
  formatElapsed,
  visibleConsoleEntries,
} from '../lib/consoleView'
import type { ConsoleLogEntry, ConsoleSnapshot } from '../constants/types'

const mockLogMain = jest.fn()
jest.mock('../main/logger', () => ({
  logMain: (...args: unknown[]) => mockLogMain(...args),
}))

function setup(
  overrides: Partial<ConstructorParameters<typeof ConsoleManager>[1]> = {},
) {
  const sent: { channel: string; data: any }[] = []
  const win = {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, data: any) => sent.push({ channel, data }),
    },
  }
  const manager = new ConsoleManager(win as any, {
    getActiveFilter: () => null,
    getActiveVideoJob: () => null,
    getActiveImportArchive: () => null,
    getImportStatus: () => ({
      isImporting: false,
      current: 0,
      total: null,
      queueLength: 0,
    }),
    ...overrides,
  })
  const snapshots = () =>
    sent
      .filter((m) => m.channel === 'consoleSnapshot')
      .map((m) => m.data as ConsoleSnapshot)
  const logs = () =>
    sent
      .filter((m) => m.channel === 'consoleLog')
      .flatMap((m) => m.data as ConsoleLogEntry[])
  return { manager, sent, snapshots, logs }
}

describe('ConsoleManager', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    mockLogMain.mockClear()
  })
  afterEach(() => jest.useRealTimers())

  it('keeps two operations at once and ends them one by one', () => {
    const { manager, snapshots } = setup()
    const filter = manager.startConsole('filter', 'Combos')
    const recording = manager.startConsole('recording', 'Recording')
    expect(
      snapshots()
        .at(-1)!
        .operations.map((o) => o.label),
    ).toEqual(['Combos', 'Recording'])

    manager.stopConsole(filter)
    expect(
      snapshots()
        .at(-1)!
        .operations.map((o) => o.label),
    ).toEqual(['Recording'])

    manager.stopConsole(recording)
    expect(snapshots().at(-1)!.operations).toEqual([])
    manager.cleanup()
  })

  it('sends the status zone only when it changed', () => {
    const { manager, snapshots } = setup()
    manager.startConsole('import', 'Import', { live: false })
    const before = snapshots().length
    jest.advanceTimersByTime(5000)
    expect(snapshots().length).toBe(before)
    manager.cleanup()
  })

  it('batches log lines, numbers them and mirrors them to main.log', () => {
    const { manager, logs } = setup()
    manager.pushConsoleLog('info', 'one')
    manager.pushConsoleLog('error', 'two')
    expect(logs()).toEqual([])
    jest.advanceTimersByTime(250)
    expect(logs().map((l) => [l.id, l.level, l.message])).toEqual([
      [1, 'info', 'one'],
      [2, 'error', 'two'],
    ])
    expect(mockLogMain).toHaveBeenCalledWith('console error', 'two')
    manager.cleanup()
  })

  it('sends a note with no operation running', () => {
    const { manager, logs } = setup()
    manager.pushConsoleNote('Dolphin is slow')
    jest.advanceTimersByTime(250)
    expect(logs()[0]).toMatchObject({
      level: 'warn',
      message: 'Dolphin is slow',
    })
    manager.cleanup()
  })

  it('keeps a worker start time while it stays on the same file', () => {
    let file = 'a.slp'
    const pool = {
      getWorkerStatus: () => [{ workerId: 0, filePath: `/x/${file}` }],
    }
    const { manager, snapshots } = setup({
      getActiveImportArchive: () => ({ activeImportPool: pool }) as any,
    })
    manager.startConsole('import', 'Import')
    const first = snapshots().at(-1)!.operations[0].workers[0]
    jest.advanceTimersByTime(3000)
    expect(snapshots().at(-1)!.operations[0].workers[0].startedAt).toBe(
      first.startedAt,
    )
    file = 'b.slp'
    jest.advanceTimersByTime(1000)
    const next = snapshots().at(-1)!.operations[0].workers[0]
    expect(next.label).toBe('b.slp')
    expect(next.startedAt).toBeGreaterThan(first.startedAt)
    manager.cleanup()
  })

  it('a zip extraction does not read the import pool', () => {
    const { manager, snapshots } = setup({
      getImportStatus: () => ({
        isImporting: true,
        current: 5,
        total: 10,
        queueLength: 0,
      }),
    })
    manager.startConsole('import', 'Extracting a.zip', { live: false })
    expect(snapshots().at(-1)!.operations[0].aggregate).toEqual({
      current: 0,
      total: 0,
    })
    manager.cleanup()
  })
})

describe('console view helpers', () => {
  const entries: ConsoleLogEntry[] = [
    { id: 1, ts: 0, level: 'info', message: 'Import complete' },
    { id: 2, ts: 0, level: 'warn', message: 'Skipped 3 games' },
    { id: 3, ts: 0, level: 'error', message: 'Dolphin crashed' },
  ]

  it('filters by level and search text', () => {
    expect(visibleConsoleEntries(entries, 'all', '')).toHaveLength(3)
    expect(
      visibleConsoleEntries(entries, 'problems', '').map((e) => e.id),
    ).toEqual([2, 3])
    expect(
      visibleConsoleEntries(entries, 'errors', '').map((e) => e.id),
    ).toEqual([3])
    expect(
      visibleConsoleEntries(entries, 'all', ' DOLPHIN ').map((e) => e.id),
    ).toEqual([3])
  })

  it('copies lines as text with their level', () => {
    const text = consoleText(entries.slice(1))
    expect(text.split('\n')[0]).toMatch(
      /^\d\d:\d\d:\d\d \[warn\] Skipped 3 games$/,
    )
  })

  it('formats elapsed time', () => {
    expect(formatElapsed(65_000)).toBe('1:05')
    expect(formatElapsed(3_729_000)).toBe('1:02:09')
    expect(formatElapsed(-5)).toBe('0:00')
  })
})
