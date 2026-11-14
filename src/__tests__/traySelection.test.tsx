/**
 * The tray's selection at any table size (lib/selection.ts): Select All on a big
 * table is a flag (no id list read or sent), Delete hands main the selection to
 * resolve, the duration comes from main's sums; on a table the tray holds whole,
 * Select All and Delete still name the ids, as they always did. Counts, not timing.
 */
import '@testing-library/jest-dom'
import { act, useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { Tray } from '../renderer/components/Tray/Tray'
import { Selection } from '../lib/selection'
import type { ShallowArchiveInterface } from '../constants/types'

const mockState = { rows: 0 }
// More than a few results removed from a step ask first: answer the question.
async function confirmRemove() {
  const button = screen.queryByRole('button', { name: 'Remove' })
  if (button)
    await act(async () => {
      fireEvent.click(button)
    })
}

jest.mock('../renderer/ipcBridge', () => ({
  __esModule: true,
  default: {
    getResults: jest.fn(
      (
        req: { offset: number; limit: number },
        cb: (_r: { items: unknown[]; total: number }) => void,
      ) => {
        const n = Math.max(0, Math.min(req.limit, mockState.rows - req.offset))
        cb({
          items: Array.from({ length: n }, (_, i) => ({
            id: req.offset + i + 1,
            path: `/r/${req.offset + i + 1}.slp`,
            stage: 8,
            startFrame: 0,
            endFrame: 60,
          })),
          total: mockState.rows,
        })
      },
    ),
    getTableDuration: jest.fn((_t: string, cb: (_f: number) => void) =>
      cb(1_000_000),
    ),
    getSelectionDuration: jest.fn(),
    removeResults: jest.fn(),
    removeGames: jest.fn(),
    reorderClips: jest.fn(),
    debugLog: jest.fn(),
    getOverviewChunk: jest.fn(),
  },
}))
const ipc = jest.requireMock('../renderer/ipcBridge').default as Record<
  string,
  jest.Mock
>
jest.mock('../renderer/debugLog', () => ({ debugLog: () => {} }))
jest.mock('../renderer/components/AddReplays', () => ({
  __esModule: true,
  default: () => null,
  IncomingReplays: () => null,
}))

// Main's messages to the renderer, so a test can send one.
const listeners = new Map<string, Set<(..._args: unknown[]) => void>>()
const send = (channel: string, ...args: unknown[]) =>
  listeners.get(channel)?.forEach((l) => l(...args))

beforeAll(() => {
  ;(window as unknown as { electron: unknown }).electron = {
    ipcRenderer: {
      on: (channel: string, listener: (..._args: unknown[]) => void) => {
        if (!listeners.has(channel)) listeners.set(channel, new Set())
        listeners.get(channel)!.add(listener)
        return () => listeners.get(channel)?.delete(listener)
      },
    },
  }
  ;(window as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}

    disconnect() {}
  }
})

const archive = (results: number): ShallowArchiveInterface => ({
  path: '/p.lunar',
  name: 'p',
  createdAt: 0,
  files: results,
  filters: [
    {
      id: 'files',
      type: 'files',
      label: 'Games',
      isProcessed: true,
      params: {},
      results,
    },
    {
      id: 'f1',
      type: 'comboFilter',
      label: 'Combos',
      isProcessed: true,
      params: {},
      results,
    },
  ],
})

let current = Selection.none()
let duration: number | null = null
let select: (_f: (_prev: Selection) => Selection) => void = () => {}
function Harness({ results }: { results: number }) {
  const [selection, setSelection] = useState(Selection.none())
  const [, setLast] = useState<number | null>(null)
  const [dur, setDur] = useState<number | null>(null)
  current = selection
  duration = dur
  select = setSelection
  return (
    <Tray
      openInSingle={false}
      archive={archive(results)}
      activeFilterId="f1"
      selection={selection}
      setSelection={setSelection}
      lastSelectedIndex={null}
      setLastSelectedIndex={setLast}
      setSelectionDuration={setDur}
      addStartFrames={10}
      addEndFrames={20}
    />
  )
}

async function open(results: number) {
  mockState.rows = results
  render(<Harness results={results} />)
  // The window's debounced fetch.
  await act(async () => {
    jest.advanceTimersByTime(200)
  })
}

beforeEach(() => {
  jest.useFakeTimers()
  Object.values(ipc).forEach((f) => f.mockClear())
})
afterEach(() => jest.useRealTimers())

describe('Tray selection', () => {
  it('Select All on 1M rows is a flag; Delete sends it for main to resolve', async () => {
    await open(1_000_000)
    expect(ipc.getResults).toHaveBeenCalledTimes(1) // just the window
    await act(async () => {
      fireEvent.click(screen.getByText('Select All'))
    })
    expect(current.all).toBe(true)
    expect(current.count).toBe(1_000_000)
    expect(current.bits.size).toBe(0)
    expect(screen.getByText('Deselect All')).toBeInTheDocument()
    // Duration: the table's sum, once; nothing left out to subtract.
    await act(async () => {
      jest.advanceTimersByTime(200)
    })
    expect(ipc.getTableDuration).toHaveBeenCalledTimes(1)
    expect(ipc.getSelectionDuration).not.toHaveBeenCalled()
    expect(duration).toBe(1_000_000 + 1_000_000 * 30)

    await act(async () => {
      fireEvent.keyDown(window, { key: 'Delete' })
    })
    await confirmRemove()
    expect(ipc.removeResults).toHaveBeenCalledTimes(1)
    const sent = ipc.removeResults.mock.calls[0][0]
    expect(sent.filterId).toBe('f1')
    expect(sent.rowIds).toBeUndefined()
    expect(sent.selection.all).toBe(true)
    expect(sent.selection.words.length).toBe(0)
    expect(current.isEmpty).toBe(true)
  })

  it('with rows left out, main adds up just those (the table sum is kept)', async () => {
    await open(1_000_000)
    await act(async () => {
      fireEvent.click(screen.getByText('Select All'))
    })
    const asked: { all: boolean; keys: number[] }[] = []
    ipc.getSelectionDuration.mockImplementation(
      (
        req: { filterId: string; selection: { all: boolean; keys: number[] } },
        cb: (_r: { frames: number; count: number }) => void,
      ) => {
        expect(req.filterId).toBe('f1')
        asked.push(req.selection)
        cb({ frames: 60 * 3, count: 3 })
      },
    )
    // Leave out ids 1-3 (Ctrl-clicks, Deselect visible).
    await act(async () => {
      select((prev) => prev.with([1, 2, 3], false))
    })
    await act(async () => {
      jest.advanceTimersByTime(200)
    })
    expect(current.count).toBe(999_997)
    // Main is asked about the three rows left out, as a plain selection.
    expect(asked).toEqual([expect.objectContaining({ all: false, keys: [0] })])
    expect(duration).toBe(1_000_000 - 180 + 999_997 * 30)
    // Another one out: the table's sum isn't asked for again.
    await act(async () => {
      select((prev) => prev.with([4], false))
    })
    await act(async () => {
      jest.advanceTimersByTime(200)
    })
    expect(ipc.getTableDuration).toHaveBeenCalledTimes(1)
    expect(ipc.getSelectionDuration).toHaveBeenCalledTimes(2)
  })

  it('a range past the loaded rows: main sums it; a big one is sent as bits', async () => {
    await open(1_000_000)
    ipc.getSelectionDuration.mockImplementation(
      (_req: unknown, cb: (_r: { frames: number; count: number }) => void) =>
        cb({ frames: 600, count: 10 }),
    )
    const far = (n: number) => Array.from({ length: n }, (_, i) => 500_000 + i)
    await act(async () => {
      select(() => Selection.of(far(10)))
    })
    await act(async () => {
      jest.advanceTimersByTime(200)
    })
    expect(ipc.getSelectionDuration).toHaveBeenCalledTimes(1)
    expect(duration).toBe(600 + 10 * 30)
    // A short list is still removed by id...
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Delete' })
    })
    await confirmRemove()
    expect(ipc.removeResults).toHaveBeenLastCalledWith(
      { filterId: 'f1', rowIds: far(10) },
      expect.any(Function),
    )
    // ...a big one goes as the selection (bits), not a list of ids.
    await act(async () => {
      select(() => Selection.of(far(200_000)))
    })
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Delete' })
    })
    await confirmRemove()
    const sent = ipc.removeResults.mock.calls[1][0]
    expect(sent.rowIds).toBeUndefined()
    expect(sent.selection.all).toBe(false)
    expect(sent.selection.words.byteLength).toBeLessThan(40_000)
  })

  it('a table held whole still names its ids (as before)', async () => {
    await open(50)
    await act(async () => {
      fireEvent.click(screen.getByText('Select All'))
    })
    expect(current.all).toBe(false)
    expect(current.count).toBe(50)
    // Every selected clip is loaded: the duration is added up here.
    await act(async () => {
      jest.advanceTimersByTime(200)
    })
    expect(ipc.getTableDuration).not.toHaveBeenCalled()
    expect(ipc.getSelectionDuration).not.toHaveBeenCalled()
    expect(duration).toBe(50 * (60 + 30))
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Delete' })
    })
    await confirmRemove()
    expect(ipc.removeResults).toHaveBeenCalledWith(
      { filterId: 'f1', rowIds: Array.from({ length: 50 }, (_, i) => i + 1) },
      expect.any(Function),
    )
  })

  it('Ctrl+A selects the loaded window; Escape clears', async () => {
    await open(1_000_000)
    await act(async () => {
      fireEvent.keyDown(window, { key: 'a', ctrlKey: true })
    })
    expect(current.all).toBe(false)
    expect(current.count).toBe(2000)
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' })
    })
    expect(current.isEmpty).toBe(true)
  })

  it('the game-length repair makes Select All read the table total again', async () => {
    await open(1_000_000)
    await act(async () => {
      fireEvent.click(screen.getByText('Select All'))
    })
    await act(async () => {
      jest.advanceTimersByTime(200)
    })
    expect(ipc.getTableDuration).toHaveBeenCalledTimes(1)
    expect(duration).toBe(1_000_000 + 1_000_000 * 30)
    const fetches = ipc.getResults.mock.calls.length

    // The repair gives games their length: the total is asked for again
    // (without reselecting), and the loaded rows are read again.
    ipc.getTableDuration.mockImplementation(
      (_t: string, cb: (_f: number) => void) => cb(3_000_000),
    )
    const status = (
      state: string,
      repaired: number,
      projectPath = '/p.lunar',
    ) => ({
      projectPath,
      state,
      total: 63_336,
      checked: repaired,
      repaired,
      missing: 0,
      unreadable: 0,
      resultsRows: 0,
    })
    // Another project's repair: nothing to do here.
    await act(async () => {
      send('lastFrameScanStatus', status('running', 500, '/other.lunar'))
      jest.advanceTimersByTime(6000)
    })
    expect(ipc.getTableDuration).toHaveBeenCalledTimes(1)

    await act(async () => {
      send('lastFrameScanStatus', status('running', 500))
      // The first read again isn't held back.
      jest.advanceTimersByTime(0)
    })
    await act(async () => {
      jest.advanceTimersByTime(200)
    })
    expect(ipc.getTableDuration).toHaveBeenCalledTimes(2)
    expect(duration).toBe(3_000_000 + 1_000_000 * 30)
    expect(ipc.getResults.mock.calls.length).toBeGreaterThan(fetches)

    // More progress soon after: read again at most every few seconds.
    ipc.getTableDuration.mockImplementation(
      (_t: string, cb: (_f: number) => void) => cb(4_000_000),
    )
    await act(async () => {
      send('lastFrameScanStatus', status('running', 900))
      jest.advanceTimersByTime(1000)
    })
    expect(ipc.getTableDuration).toHaveBeenCalledTimes(2)
    // Finished: read at once.
    ipc.getTableDuration.mockImplementation(
      (_t: string, cb: (_f: number) => void) => cb(5_000_000),
    )
    await act(async () => {
      send('lastFrameScanStatus', status('done', 63_336))
    })
    await act(async () => {
      jest.advanceTimersByTime(200)
    })
    expect(duration).toBe(5_000_000 + 1_000_000 * 30)
    // The pending progress read was folded into it.
    await act(async () => {
      jest.advanceTimersByTime(10_000)
    })
    expect(ipc.getTableDuration).toHaveBeenCalledTimes(3)
  })
})
