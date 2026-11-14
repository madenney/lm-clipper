/**
 * Debug logger for renderer - sends to main process to write to file
 */

import ipcBridge from './ipcBridge'

const queue: string[] = []
let flushTimer: number | null = null

const flush = () => {
  if (flushTimer != null) {
    window.clearTimeout(flushTimer)
    flushTimer = null
  }
  if (queue.length === 0) return
  const batch = queue.splice(0, queue.length)
  ipcBridge.debugLog(batch)
}

/** Only a development build writes the debug log (main appends it to a file); a release build's
 *  debugLog does nothing, so no one's folder gets a logs/debug.log and no IPC runs per zoom step. */
const enabled = () => process.env.NODE_ENV === 'development'

export const debugLog = (label: string, data?: any) => {
  // Developer diagnostics: nothing in a shipped build (launch review CR-1).
  if (process.env.NODE_ENV !== 'development') return
  const ts = new Date().toISOString()
  const line =
    data !== undefined
      ? `[${ts}] ${label} ${JSON.stringify(data)}`
      : `[${ts}] ${label}`

  queue.push(line)

  // Also console.log for immediate visibility
  console.log(line)

  // Debounce flush
  if (flushTimer != null) window.clearTimeout(flushTimer)
  flushTimer = window.setTimeout(flush, 100)
}

// Flush on unload
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', flush)
}
