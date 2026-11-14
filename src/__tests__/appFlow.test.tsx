/**
 * The app shell from the launch review (CR-4, CR-7, CR-8, CR-10, CR-14, UX-15): the start screen
 * is never blank, its buttons say why they failed, a failed launch update check stays quiet, the
 * usage notice stays until OK, and Help > Welcome on the start screen does something.
 */
import '@testing-library/jest-dom'
import { act } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { config as defaultConfig } from '../constants/defaults'

type Handler = (..._args: any[]) => void
const listeners = new Map<string, Set<Handler>>()
const fire = (channel: string, ...args: any[]) =>
  act(() => {
    listeners.get(channel)?.forEach((h) => h(...args))
  })

const state: {
  recent: { name: string; path: string }[]
  slippi: { dir: string; count: number } | null | 'pending'
  archive: any
} = { recent: [], slippi: null, archive: null }

jest.mock('../renderer/ipcBridge', () => {
  const calls: Record<string, jest.Mock> = {}
  const answers: Record<string, (_cb: any) => void> = {
    getConfig: (cb) => cb(mockConfig()),
    getArchive: (cb) => cb(state.archive),
    getRecentProjects: (cb) => cb(state.recent),
    detectSlippiReplays: (cb) => {
      if (state.slippi !== 'pending') cb(state.slippi)
    },
    getImportStatus: (cb) => cb({ isImporting: false }),
  }
  const proxy: any = new Proxy(
    { __calls: calls },
    {
      get(target: any, name: string) {
        if (name === '__esModule') return true
        if (name === 'default') return proxy
        if (name === '__calls') return calls
        if (!calls[name]) {
          calls[name] = jest.fn((...args: any[]) => {
            const cb = args.find((a) => typeof a === 'function')
            if (cb && answers[name]) answers[name](cb)
          })
        }
        return calls[name]
      },
    },
  )
  return proxy
})
const bridge = jest.requireMock('../renderer/ipcBridge') as Record<
  string,
  jest.Mock
> & { __calls: Record<string, jest.Mock> }
function mockConfig() {
  return { ...defaultConfig, consentNoticeSeen: false, hideWelcome: true }
}
const ipcCalls = () => bridge.__calls
const fn = (name: string) => (bridge as any)[name] as jest.Mock

// eslint-disable-next-line import/first
import App from '../renderer/App'

const wait = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })

const sent: [string, unknown][] = []
beforeAll(() => {
  ;(window as any).electron = {
    ipcRenderer: {
      sendMessage: (channel: string, payload: unknown) =>
        sent.push([channel, payload]),
      once: () => {},
      on: (channel: string, handler: Handler) => {
        if (!listeners.has(channel)) listeners.set(channel, new Set())
        listeners.get(channel)!.add(handler)
        return () => listeners.get(channel)?.delete(handler)
      },
    },
  }
  ;(window as any).ResizeObserver = class {
    observe() {}

    disconnect() {}
  }
  window.matchMedia =
    window.matchMedia ||
    (((query: string) => ({
      matches: false,
      media: query,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
    })) as any)
})

beforeEach(() => {
  listeners.clear()
  sent.length = 0
  Object.keys(ipcCalls()).forEach((k) => delete ipcCalls()[k])
  state.recent = []
  state.slippi = null
  state.archive = null
})

async function start() {
  await act(async () => {
    render(<App />)
  })
}

describe('start screen', () => {
  it('shows the logo and the ways in at once, while the Slippi folder is still searched', async () => {
    state.slippi = 'pending'
    await start()
    expect(screen.getByAltText('Lunar Clipper')).toBeInTheDocument()
    expect(
      screen.getByText('Looking for your Slippi replays...'),
    ).toBeInTheDocument()
    expect(screen.getByText('Choose local replays')).toBeInTheDocument()
    expect(screen.getByText('Start empty project')).toBeInTheDocument()
  })

  it('an import that fails says why instead of doing nothing', async () => {
    await start()
    fn('importSlpFiles').mockImplementation((cb: Handler) =>
      cb({ error: 'Failed to create project' }),
    )
    await act(async () => {
      fireEvent.click(screen.getByText('Choose local replays'))
    })
    expect(screen.getByRole('status')).toHaveTextContent(
      /Couldn't start a project for these replays/,
    )
  })

  it('a cancelled file dialog says nothing', async () => {
    await start()
    fn('importSlpFiles').mockImplementation((cb: Handler) => cb(null))
    await act(async () => {
      fireEvent.click(screen.getByText('Choose local replays'))
    })
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
  })

  it('a recent project that is gone says so, and leaves the list', async () => {
    state.recent = [{ name: 'Old project', path: '/gone/old.lunar' }]
    await start()
    fn('openRecentProject').mockImplementation((_path: string, cb: Handler) =>
      cb({ error: 'Project file not found' }),
    )
    await act(async () => {
      fireEvent.click(screen.getByText('Old project'))
    })
    expect(screen.getByRole('status')).toHaveTextContent(/Recent list/)
    expect(screen.queryByText('Old project')).toBeNull()
  })
})

describe('usage notice', () => {
  it('shows on the start screen until OK, and OK saves it', async () => {
    await start()
    expect(
      screen.getByRole('region', { name: 'Usage statistics notice' }),
    ).toBeInTheDocument()
    await act(async () => {
      fireEvent.click(screen.getByText('OK'))
    })
    expect(fn('updateConfig')).toHaveBeenCalledWith({
      key: 'consentNoticeSeen',
      value: true,
    })
    expect(
      screen.queryByRole('region', { name: 'Usage statistics notice' }),
    ).toBeNull()
  })
})

describe('update check', () => {
  const dismissEverything = () => fire('update-not-available')

  it('a failed launch check stays quiet', async () => {
    await start()
    fire('update-error', 'getaddrinfo ENOTFOUND github.com')
    expect(screen.queryByText(/Couldn't reach the update server/)).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('a failed check the user asked for is shown, in plain words', async () => {
    await start()
    fire('trigger-update-check')
    expect(
      sent.filter(([c]) => c === 'check-for-updates').map(([, p]) => p),
    ).toEqual([{ silent: true }, {}])
    fire('update-error', 'getaddrinfo ENOTFOUND github.com')
    expect(screen.getByRole('alert')).toHaveTextContent(
      /Couldn't reach the update server/,
    )
    dismissEverything()
  })

  it('an error while an update that was found downloads is shown', async () => {
    await start()
    fire('update-available', '3.0.1')
    fire('update-error', 'download failed')
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })
})

describe('Help > Welcome with no project', () => {
  it('a start option opens My Replays first, then acts', async () => {
    state.archive = null
    state.recent = []
    // Hidden on its own; Help opens it by hand.
    await start()
    fire('showWelcome')
    const chosen: unknown[] = []
    window.addEventListener('lunar:startOption', (e) =>
      chosen.push((e as CustomEvent).detail),
    )
    fn('openMyReplays').mockImplementation((cb: Handler) =>
      cb({
        path: '/my.lunar',
        name: 'My Replays',
        createdAt: 0,
        files: 0,
        filters: [
          {
            id: 'files',
            type: 'files',
            label: 'Replays',
            isProcessed: true,
            params: {},
            results: 0,
          },
        ],
      }),
    )
    await act(async () => {
      fireEvent.click(screen.getByText('Look for combos'))
    })
    // The card's leave animation, then React's effects and the 0 ms timer after them.
    await act(async () => {
      await wait(600)
    })
    await act(async () => {
      await wait(30)
    })
    expect(fn('openMyReplays')).toHaveBeenCalledTimes(1)
    expect(chosen).toEqual(['combos'])
  })

  it('says why when My Replays cannot be opened, and does not act', async () => {
    await start()
    fire('showWelcome')
    const chosen: unknown[] = []
    window.addEventListener('lunar:startOption', (e) =>
      chosen.push((e as CustomEvent).detail),
    )
    fn('openMyReplays').mockImplementation((cb: Handler) =>
      cb({ error: 'Could not open My Replays.' }),
    )
    await act(async () => {
      fireEvent.click(screen.getByText('Look for combos'))
    })
    // The card's leave animation, then React's effects and the 0 ms timer after them.
    await act(async () => {
      await wait(600)
    })
    await act(async () => {
      await wait(30)
    })
    expect(screen.getByRole('status')).toHaveTextContent(
      /Couldn't create the project: Could not open My Replays/,
    )
    expect(chosen).toEqual([])
  })
})
