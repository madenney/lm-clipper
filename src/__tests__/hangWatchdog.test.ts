/**
 * @jest-environment node
 *
 * The "not responding" diagnostics (main/hangWatchdog.ts).
 */
const onCalls: { channel: string; listener: Function }[] = []
const originalOn = jest.fn((channel: string, listener: Function) => {
  onCalls.push({ channel, listener })
})

jest.mock('electron', () => ({
  ipcMain: {
    get on() {
      return (global as any).__ipcOn
    },
    set on(fn: any) {
      ;(global as any).__ipcOn = fn
    },
  },
  BrowserWindow: class {},
}))

const logMain = jest.fn()
jest.mock('../main/logger', () => ({ logMain: (...a: any[]) => logMain(...a) }))

// eslint-disable-next-line import/first
import { ipcMain } from 'electron'
// eslint-disable-next-line import/first
import {
  timeHandler,
  registerTimedHandlers,
  SLOW_SYNC_MS,
} from '../main/hangWatchdog'

let now = 0
beforeEach(() => {
  ;(global as any).__ipcOn = originalOn
  onCalls.length = 0
  logMain.mockClear()
  now = 1_000_000
  jest.spyOn(Date, 'now').mockImplementation(() => now)
})
afterEach(() => jest.restoreAllMocks())

describe('timeHandler', () => {
  it('logs a handler whose synchronous part blocks too long', () => {
    const wrapped = timeHandler('slowThing', () => {
      now += SLOW_SYNC_MS + 50
    })
    wrapped({} as any)
    expect(logMain).toHaveBeenCalledWith('main-slow-handler', {
      channel: 'slowThing',
      syncMs: SLOW_SYNC_MS + 50,
    })
  })

  it('stays quiet for fast handlers and passes arguments and results through', async () => {
    const wrapped = timeHandler('fast', (_e, a: number, b: number) =>
      Promise.resolve(a + b),
    )
    await expect(wrapped({} as any, 2, 3)).resolves.toBe(5)
    expect(logMain).not.toHaveBeenCalled()
  })

  it('rethrows handler errors', () => {
    const wrapped = timeHandler('boom', () => {
      throw new Error('boom')
    })
    expect(() => wrapped({} as any)).toThrow('boom')
  })
})

describe('registerTimedHandlers', () => {
  it('wraps handlers registered inside it, then restores ipcMain.on', () => {
    const handler = jest.fn()
    registerTimedHandlers(() => {
      ipcMain.on('getThing', handler)
    })
    expect(ipcMain.on).toBe(originalOn)
    expect(onCalls).toHaveLength(1)
    expect(onCalls[0].channel).toBe('getThing')
    // Registered function is the wrapper, which still calls the handler.
    expect(onCalls[0].listener).not.toBe(handler)
    onCalls[0].listener({}, 'x')
    expect(handler).toHaveBeenCalledWith({}, 'x')
  })

  it('restores ipcMain.on even if registration throws', () => {
    expect(() =>
      registerTimedHandlers(() => {
        throw new Error('bad')
      }),
    ).toThrow('bad')
    expect(ipcMain.on).toBe(originalOn)
  })
})
