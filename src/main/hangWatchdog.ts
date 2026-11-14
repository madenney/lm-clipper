import { BrowserWindow, IpcMainEvent, ipcMain } from 'electron'
import { logMain } from './logger'

// Finds out what freezes the app ("not responding"). Everything goes to
// main.log, which users can already export (Help → Export logs):
//
//  main-slow-handler   an IPC handler's synchronous part ran >= SLOW_SYNC_MS
//                      (it blocked the main process for that long)
//  main-blocked        the main process could not run its timer for
//                      >= BLOCKED_MS, with the requests in flight at the time
//                      (an await continuation in one of them is the likely cause)
//  window-unresponsive / window-responsive
//                      Electron's own verdict on the window, with duration
//  renderer-longtask   the window's own JS blocked >= RENDERER_LONGTASK_MS
//                      (mirrored from the renderer's perf log; controller.ts)

export const SLOW_SYNC_MS = 200
export const BLOCKED_MS = 1000
export const RENDERER_LONGTASK_MS = 500
const TICK_MS = 250
const MAX_REPORTED = 10

const inflight = new Map<number, { channel: string; start: number }>()
let nextId = 0

function inflightSummary(now = Date.now()) {
  return Array.from(inflight.values())
    .slice(-MAX_REPORTED)
    .map((r) => ({ channel: r.channel, ageMs: now - r.start }))
}

type Listener = (_event: IpcMainEvent, ..._args: any[]) => any

/** Wrap one IPC handler: time its synchronous part, track it while async. */
export function timeHandler(channel: string, listener: Listener): Listener {
  return (event, ...args) => {
    const id = (nextId += 1)
    const start = Date.now()
    inflight.set(id, { channel, start })
    let result: any
    try {
      result = listener(event, ...args)
    } catch (error) {
      inflight.delete(id)
      throw error
    } finally {
      const syncMs = Date.now() - start
      if (syncMs >= SLOW_SYNC_MS) {
        logMain('main-slow-handler', { channel, syncMs })
      }
    }
    if (result && typeof result.then === 'function') {
      result.then(
        () => inflight.delete(id),
        () => inflight.delete(id),
      )
    } else {
      inflight.delete(id)
    }
    return result
  }
}

/**
 * Run `register` with ipcMain.on temporarily wrapped by timeHandler. Only the
 * permanent handlers registered inside it are timed: code that later adds and
 * removes its own listeners (wizards, code editor) keeps the original
 * ipcMain.on, so removeListener still matches the function it was given.
 */
export function registerTimedHandlers(register: () => void) {
  const originalOn = ipcMain.on
  ipcMain.on = function timedOn(channel: string, listener: Listener) {
    return originalOn.call(ipcMain, channel, timeHandler(channel, listener))
  } as typeof ipcMain.on
  try {
    register()
  } finally {
    ipcMain.on = originalOn
  }
}

let monitorStarted = false

/** Log whenever the main process was stuck for BLOCKED_MS or more. */
export function startMainWatchdog() {
  if (monitorStarted) return
  monitorStarted = true
  let last = Date.now()
  const timer = setInterval(() => {
    const now = Date.now()
    const lag = now - last - TICK_MS
    last = now
    if (lag >= BLOCKED_MS) {
      logMain('main-blocked', { ms: lag, inflight: inflightSummary(now) })
    }
  }, TICK_MS)
  timer.unref?.()
}

/** Log Electron's own unresponsive/responsive verdicts for a window. */
export function watchWindow(win: BrowserWindow) {
  let since: number | null = null
  win.on('unresponsive', () => {
    since = Date.now()
    logMain('window-unresponsive', { inflight: inflightSummary() })
  })
  win.on('responsive', () => {
    if (since == null) return
    logMain('window-responsive', { afterMs: Date.now() - since })
    since = null
  })
}
