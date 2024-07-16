import { URL } from 'url'
import path from 'path'
import os from 'os'
import { app } from 'electron'

export function resolveHtmlPath(htmlFileName: string) {
  if (process.env.NODE_ENV === 'development') {
    const port = process.env.PORT || 1212
    const url = new URL(`http://localhost:${port}`)
    url.pathname = htmlFileName
    return url.href
  }
  return `file://${path.resolve(__dirname, '../renderer/', htmlFileName)}`
}

export function getFFMPEGPath() {

  if (process.env.NODE_ENV === 'development') {
    return 'ffmpeg'
  }

  const appPath = app.getAppPath()
  const type = os.type()
  switch (type) {
    case 'Linux':
      return path.resolve(appPath, 'ffmpeg', 'ffmpeg-linux-x64')
    case 'Windows_NT':
      return path.resolve(appPath, 'ffmpeg', 'ffmpeg-win32-x64')
    case 'Darwin':
    default:
      throw new Error('no os?')
  }
}


export function getSqlitePath() {

  if (process.env.NODE_ENV === 'development') {
    return path.resolve(app.getAppPath(), 'bin', 'sqlite3')
  }

  const appPath = app.getAppPath()
  const type = os.type()
  switch (type) {
    case 'Linux':
      return path.resolve(appPath, 'sqlite3', 'sqlite3')
    case 'Windows_NT':
      return path.resolve(appPath, 'sqlite3', 'sqlite3.exe')
    case 'Darwin':
    default:
      throw new Error('no os?')
  }
}
