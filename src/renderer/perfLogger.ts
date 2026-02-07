import ipcBridge from './ipcBridge'

type PerfEvent = {
  name: string
  ts: number
  durationMs?: number
  meta?: Record<string, string | number | boolean | null>
}

const flushIntervalMs = 2000
const maxQueueSize = 200
const queue: PerfEvent[] = []
let flushTimer: number | null = null

const flush = () => {
  if (flushTimer != null) {
    window.clearTimeout(flushTimer)
    flushTimer = null
  }
  if (queue.length === 0) return
  const batch = queue.splice(0, queue.length)
  ipcBridge.logPerfEvents(batch)
}

const scheduleFlush = () => {
  if (flushTimer != null) return
  flushTimer = window.setTimeout(() => {
    flushTimer = null
    flush()
  }, flushIntervalMs)
}

const enqueue = (event: PerfEvent) => {
  queue.push(event)
  if (queue.length >= maxQueueSize) {
    flush()
  } else {
    scheduleFlush()
  }
}

export const perfLog = {
  event(name: string, meta?: PerfEvent['meta']) {
    enqueue({ name, ts: Date.now(), meta })
  },
  duration(name: string, durationMs: number, meta?: PerfEvent['meta']) {
    enqueue({ name, ts: Date.now(), durationMs, meta })
  },
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => flush())
}

export const initPerfObservers = () => {
  if (typeof PerformanceObserver === 'undefined') return
  try {
    const observer = new PerformanceObserver((list) => {
      list.getEntries().forEach((entry) => {
        const durationMs = Math.round(entry.duration * 100) / 100
        perfLog.duration('longtask', durationMs, { name: entry.name })
      })
    })
    observer.observe({ entryTypes: ['longtask'] })
  } catch (error) {
    perfLog.event('perf_observer_error', {
      message: error instanceof Error ? error.message : 'unknown',
    })
  }
}
