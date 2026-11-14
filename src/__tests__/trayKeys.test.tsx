/**
 * The tray's window-wide keys and its empty states (launch review CR-6, CR-9, CR-18, UX-14):
 * Backspace/Delete/Esc/Ctrl+A leave an open dialog, a dropdown and typing alone, removing more than a
 * few results asks first, and an empty step says what actually happened.
 */
import '@testing-library/jest-dom'
import { act, useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { Tray } from '../renderer/components/Tray/Tray'
import { Selection } from '../lib/selection'
import type { ShallowArchiveInterface } from '../constants/types'

const mockState = { rows: 0, fail: false }
jest.mock('../renderer/ipcBridge', () => ({
  __esModule: true,
  default: {
    getResults: jest.fn(
      (
        req: { offset: number; limit: number },
        cb: (_r: { items: unknown[] | null; total: number }) => void,
      ) => {
        if (mockState.fail) {
          cb({ items: null, total: 0 })
          return
        }
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
      cb(1000),
    ),
    getSelectionDuration: jest.fn(),
    removeResults: jest.fn(),
    removeGames: jest.fn(),
    previewRemoveGames: jest.fn(),
    reorderClips: jest.fn(),
    getOverviewChunk: jest.fn(),
    database: jest.fn(),
  },
}))
const ipc = jest.requireMock('../renderer/ipcBridge').default as Record<
  string,
  jest.Mock
>
jest.mock('../renderer/components/AddReplays', () => ({
  __esModule: true,
  default: () => null,
  IncomingReplays: () => null,
}))

beforeAll(() => {
  ;(window as unknown as { electron: unknown }).electron = {
    ipcRenderer: { on: () => () => {} },
  }
  ;(window as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}

    disconnect() {}
  }
})

const archive = (
  results: number,
  processed = true,
): ShallowArchiveInterface => ({
  path: '/p.lunar',
  name: 'p',
  createdAt: 0,
  files: 100,
  filters: [
    {
      id: 'files',
      type: 'files',
      label: 'Games',
      isProcessed: true,
      params: {},
      results: 100,
    },
    {
      id: 'f1',
      type: 'comboFilter',
      label: 'Combos',
      isProcessed: processed,
      params: {},
      results,
    },
  ],
})

let current = Selection.none()
let select: (_f: (_prev: Selection) => Selection) => void = () => {}
function Harness({
  results,
  processed = true,
}: {
  results: number
  processed?: boolean
}) {
  const [selection, setSelection] = useState(Selection.none())
  const [, setLast] = useState<number | null>(null)
  current = selection
  select = setSelection
  return (
    <div>
      <button type="button" id="elsewhere">
        a button outside the tray
      </button>
      <Tray
        openInSingle={false}
        archive={archive(results, processed)}
        activeFilterId="f1"
        selection={selection}
        setSelection={setSelection}
        lastSelectedIndex={null}
        setLastSelectedIndex={setLast}
        setSelectionDuration={() => {}}
        addStartFrames={0}
        addEndFrames={0}
      />
    </div>
  )
}

async function open(results: number, processed = true) {
  mockState.rows = results
  render(<Harness results={results} processed={processed} />)
  await act(async () => {
    jest.advanceTimersByTime(200)
  })
}

const press = async (key: string, target: Element | Window = window) => {
  await act(async () => {
    fireEvent.keyDown(target, { key })
  })
}

beforeEach(() => {
  jest.useFakeTimers()
  mockState.fail = false
  Object.values(ipc).forEach((f) => f.mockClear())
})
afterEach(() => jest.useRealTimers())

describe('tray keys leave dialogs and typing alone', () => {
  it('Backspace removes the selected results of a step, a few at once', async () => {
    await open(10)
    await act(async () => {
      select(() => Selection.of([1, 2, 3]))
    })
    await press('Backspace')
    expect(ipc.removeResults).toHaveBeenCalledTimes(1)
  })

  it('Backspace with a dialog open (Settings, a dropdown) removes nothing', async () => {
    await open(10)
    await act(async () => {
      select(() => Selection.of([1, 2, 3]))
    })
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    document.body.appendChild(dialog)
    await press('Backspace')
    await press('Escape')
    await press('a')
    expect(ipc.removeResults).not.toHaveBeenCalled()
    // Esc closed the dialog, not the selection behind it.
    expect(current.count).toBe(3)
    dialog.remove()
    await press('Backspace')
    expect(ipc.removeResults).toHaveBeenCalledTimes(1)
  })

  it('Backspace on a button elsewhere in the window removes nothing', async () => {
    await open(10)
    await act(async () => {
      select(() => Selection.of([1, 2, 3]))
    })
    await press('Backspace', document.getElementById('elsewhere')!)
    expect(ipc.removeResults).not.toHaveBeenCalled()
  })

  it('removing more than a handful asks first; Cancel removes nothing', async () => {
    await open(100)
    await act(async () => {
      select(() => Selection.of(Array.from({ length: 30 }, (_, i) => i + 1)))
    })
    await press('Backspace')
    expect(ipc.removeResults).not.toHaveBeenCalled()
    expect(
      screen.getByRole('dialog', { name: 'Remove 30 results from this step?' }),
    ).toBeInTheDocument()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    })
    expect(ipc.removeResults).not.toHaveBeenCalled()
    expect(current.count).toBe(30)
    await press('Backspace')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    })
    expect(ipc.removeResults).toHaveBeenCalledTimes(1)
    expect(ipc.removeResults.mock.calls[0][0].rowIds).toHaveLength(30)
  })
})

describe('what an empty step says', () => {
  it('a step that has not run says to run it', async () => {
    await open(0, false)
    expect(screen.getByText('No clips to display')).toBeInTheDocument()
    expect(
      screen.getByText('Run this filter to see results'),
    ).toBeInTheDocument()
  })

  it('a step that ran and found nothing says so, with what to loosen', async () => {
    await open(0, true)
    expect(screen.getByText('No combos found')).toBeInTheDocument()
    expect(screen.getByText(/fewer minimum hits/)).toBeInTheDocument()
    expect(screen.queryByText('Run this filter to see results')).toBeNull()
  })

  it('a failed read says so and can be tried again', async () => {
    mockState.fail = true
    mockState.rows = 5
    render(<Harness results={5} />)
    await act(async () => {
      jest.advanceTimersByTime(200)
    })
    expect(screen.getByText("Couldn't read these results")).toBeInTheDocument()
    mockState.fail = false
    ipc.getResults.mockClear()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    })
    await act(async () => {
      jest.advanceTimersByTime(200)
    })
    expect(ipc.getResults).toHaveBeenCalled()
    expect(screen.queryByText("Couldn't read these results")).toBeNull()
  })
})
