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

export const debugLog = (label: string, data?: any) => {
  const ts = new Date().toISOString()
  const line = data !== undefined
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
