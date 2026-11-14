/**
 * The Lunar Database panel is mounted at the app root for the whole session. It must ask the
 * website for its status only while it is open or a download is running (CR-11), and a project
 * must not be swapped under a running filter, import or recording (CR-15).
 */
import '@testing-library/jest-dom'
import { act } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'

import DatabasePanel from '../renderer/components/DatabasePanel'
import { ArchiveContext, ConfigContext } from '../renderer/context/AppContext'
import { config as defaultConfig } from '../constants/defaults'
import type { Transfer } from '../constants/database'

const database = jest.fn()
jest.mock('../renderer/ipcBridge', () => ({
  __esModule: true,
  default: {
    database: (...args: unknown[]) => database(...args),
    getImportStatus: jest.fn(),
    openRecentProject: jest.fn(),
    getTableDuration: jest.fn(),
  },
}))
jest.mock('../renderer/components/SearchBox', () => ({
  __esModule: true,
  default: () => null,
  playerLabel: () => '',
}))
jest.mock('../renderer/components/ClipSearchTab', () => ({
  __esModule: true,
  default: () => null,
}))

type Handler = (..._args: any[]) => void
const listeners = new Map<string, Set<Handler>>()
beforeAll(() => {
  // jsdom has no scrollIntoView (the Downloads tab brings the newest card into view).
  Element.prototype.scrollIntoView = () => {}
  ;(window as any).electron = {
    ipcRenderer: {
      sendMessage: () => {},
      on: (channel: string, handler: Handler) => {
        if (!listeners.has(channel)) listeners.set(channel, new Set())
        listeners.get(channel)!.add(handler)
        return () => listeners.get(channel)?.delete(handler)
      },
    },
  }
})
const fire = (channel: string, ...args: any[]) =>
  act(() => {
    listeners.get(channel)?.forEach((h) => h(...args))
  })

const statusCalls = () =>
  database.mock.calls.filter(([req]) => req?.action === 'status').length

const archiveValue = {
  archive: {
    path: '/open.lunar',
    name: 'open',
    createdAt: 0,
    files: 0,
    filters: [],
  } as any,
  setArchive: () => {},
}
const configValue = { config: defaultConfig as any, setConfig: () => {} }

function Panel({
  tab,
  transfers = [],
}: {
  tab: 'search' | 'transfers' | null
  transfers?: Transfer[]
}) {
  return (
    <ArchiveContext.Provider value={archiveValue}>
      <ConfigContext.Provider value={configValue}>
        <DatabasePanel
          tab={tab}
          onTab={() => {}}
          transfers={transfers}
          onTransfers={() => {}}
        />
      </ConfigContext.Provider>
    </ArchiveContext.Provider>
  )
}

const job = (over: Partial<Transfer>): Transfer =>
  ({
    id: 'job-1',
    title: 'Fox games',
    stage: 'downloading',
    createdAt: Date.now(),
    projectPath: '/other.lunar',
    projectName: 'Other project',
    ...over,
  }) as unknown as Transfer

beforeEach(() => {
  listeners.clear()
  database.mockReset()
  database.mockImplementation((_req, cb) => cb?.({ status: undefined }))
})

describe('status poll', () => {
  it('does not ask while the panel is closed and nothing downloads', () => {
    render(<Panel tab={null} />)
    expect(statusCalls()).toBe(0)
  })

  it('asks as soon as the panel opens', () => {
    const { rerender } = render(<Panel tab={null} />)
    expect(statusCalls()).toBe(0)
    rerender(<Panel tab="transfers" />)
    expect(statusCalls()).toBeGreaterThan(0)
  })

  it('asks while a download runs, even with the panel closed', () => {
    render(<Panel tab={null} transfers={[job({})]} />)
    expect(statusCalls()).toBeGreaterThan(0)
  })
})

describe("going to a download's project does not swap it under running work", () => {
  // Still running: its card has the "Go to" button (games show up there as they arrive).
  const done = job({ stage: 'downloading' })

  it('asks before "Go to" when a filter is running in the open project', () => {
    render(<Panel tab="transfers" transfers={[done]} />)
    fire('currentlyRunningFilter', { runningIds: ['f1'] })
    fireEvent.click(screen.getByText(/Go to .Other project./))
    expect(
      screen.getByRole('dialog', { name: /Go to .Other project. now\?/ }),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/A filter is running in the project/),
    ).toBeInTheDocument()
  })

  it('goes straight there when nothing is running', () => {
    const bridge = jest.requireMock('../renderer/ipcBridge').default
    render(<Panel tab="transfers" transfers={[done]} />)
    fireEvent.click(screen.getByText(/Go to .Other project./))
    expect(screen.queryByRole('dialog', { name: /now\?/ })).toBeNull()
    expect(bridge.openRecentProject).toHaveBeenCalledWith(
      '/other.lunar',
      expect.any(Function),
    )
  })
})

describe('the automatic jump when a single download finishes', () => {
  const finish = async (busy: boolean) => {
    jest.useFakeTimers()
    const bridge = jest.requireMock('../renderer/ipcBridge').default
    bridge.openRecentProject.mockClear()
    const { rerender } = render(
      <Panel tab="transfers" transfers={[job({ stage: 'downloading' })]} />,
    )
    if (busy) fire('currentlyRunningFilter', { runningIds: ['f1'] })
    rerender(
      <Panel
        tab="transfers"
        transfers={[job({ stage: 'completed', finishedAt: Date.now() })]}
      />,
    )
    await act(async () => {
      jest.advanceTimersByTime(1000)
    })
    jest.useRealTimers()
    return bridge.openRecentProject as jest.Mock
  }

  it('goes to the project when nothing is running there', async () => {
    expect(await finish(false)).toHaveBeenCalledTimes(1)
  })

  it('stays where it is while a filter runs in the open project', async () => {
    expect(await finish(true)).not.toHaveBeenCalled()
  })
})
