import type { ConsoleLogEntry } from '../constants/types'

export type ConsoleLevelFilter = 'all' | 'problems' | 'errors'

const pad = (n: number) => String(n).padStart(2, '0')

export const formatConsoleTime = (ts: number) => {
  const d = new Date(ts)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** "1:05", "1:02:09". */
export const formatElapsed = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`
}

/** Lines that pass the level and search filters. */
export function visibleConsoleEntries(
  entries: ConsoleLogEntry[],
  level: ConsoleLevelFilter,
  query: string,
) {
  const q = query.trim().toLowerCase()
  return entries.filter((e) => {
    if (level === 'errors' && e.level !== 'error') return false
    if (level === 'problems' && e.level === 'info') return false
    return !q || e.message.toLowerCase().includes(q)
  })
}

/** The lines as plain text, one per line, for Copy. */
export const consoleText = (entries: ConsoleLogEntry[]) =>
  entries
    .map(
      (e) =>
        `${formatConsoleTime(e.ts)} ${e.level === 'info' ? '' : `[${e.level}] `}${e.message}`,
    )
    .join('\n')
