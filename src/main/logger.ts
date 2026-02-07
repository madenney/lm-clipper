import fs from 'fs'
import path from 'path'

const logRoot = path.resolve(process.cwd(), 'logs')

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
