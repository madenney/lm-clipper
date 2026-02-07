import { app } from 'electron'
import fs from 'fs'
import path from 'path'

type PerfEvent = {
  name: string
  ts: number
  durationMs?: number
  meta?: Record<string, string | number | boolean | null>
}

let perfLogFilePath: string | null = null

const getLogDir = () => {
  const baseDir = app.isPackaged ? app.getPath('userData') : process.cwd()
  return path.join(baseDir, 'logs')
}

const ensureLogFile = () => {
  if (perfLogFilePath) return perfLogFilePath
  const logDir = getLogDir()
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true })
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  perfLogFilePath = path.join(logDir, `perf-${stamp}.jsonl`)
  const session = {
    name: 'session_start',
    ts: Date.now(),
    meta: {
      pid: process.pid,
      platform: process.platform,
      packaged: app.isPackaged,
      cwd: process.cwd(),
    },
  }
  fs.writeFileSync(perfLogFilePath, `${JSON.stringify(session)}\n`)
  return perfLogFilePath
}

export const appendPerfEvents = async (events: PerfEvent[]) => {
  if (!events || events.length === 0) return
  const filePath = ensureLogFile()
  const lines = events.map((event) => JSON.stringify(event)).join('\n') + '\n'
  await fs.promises.appendFile(filePath, lines)
}
