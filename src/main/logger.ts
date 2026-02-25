import fs from 'fs'
import path from 'path'
import os from 'os'

const getLogRoot = () => {
  // In production, write logs next to the app's config directory so they're easy to find.
  // In dev, use cwd/logs as before.
  if (process.env.NODE_ENV === 'development') {
    return path.resolve(process.cwd(), 'logs')
  }
  const platform = os.type()
  if (platform === 'Windows_NT') {
    const appData =
      process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
    return path.join(appData, 'lm-clipper', 'logs')
  }
  if (platform === 'Darwin') {
    return path.join(
      os.homedir(),
      'Library',
      'Application Support',
      'lm-clipper',
      'logs',
    )
  }
  const configHome =
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  return path.join(configHome, 'lm-clipper', 'logs')
}

const logRoot = getLogRoot()

const ensureLogDir = () => {
  if (!fs.existsSync(logRoot)) {
    fs.mkdirSync(logRoot, { recursive: true })
  }
}

const safeStringify = (value: any) => {
  if (value instanceof Error) {
    return JSON.stringify({
      name: value.name,
      message: value.message,
      stack: value.stack,
    })
  }
  try {
    return JSON.stringify(value)
  } catch (error) {
    return JSON.stringify({ message: 'Unserializable payload' })
  }
}

const writeLog = (fileName: string, entry: string) => {
  ensureLogDir()
  const filePath = path.join(logRoot, fileName)
  fs.appendFileSync(filePath, `${entry}\n`)
}

const formatLine = (label: string, detail?: any) => {
  const timestamp = new Date().toISOString()
  if (detail === undefined) {
    return `[${timestamp}] ${label}`
  }
  return `[${timestamp}] ${label} ${safeStringify(detail)}`
}

export const logMain = (label: string, detail?: any) => {
  writeLog('main.log', formatLine(label, detail))
}

export const logRenderer = (detail?: any) => {
  writeLog('renderer.log', formatLine('renderer', detail))
}

export const getLogPath = () => logRoot
