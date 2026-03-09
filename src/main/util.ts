import { URL } from 'url'
import path from 'path'
import os from 'os'
import fs, { promises as fsPromises } from 'fs'
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

export function getGfxIniPath(dolphinPath: string): string {
  if (os.type() === 'Linux') {
    const appData = app.getPath('appData')
    return path.join(appData, 'SlippiPlayback', 'Config', 'GFX.ini')
  }
  const dolphinDir = path.dirname(dolphinPath)
  return path.join(dolphinDir, 'User', 'Config', 'GFX.ini')
}

export async function updateEfbScale(
  dolphinPath: string,
  efbScale: number,
): Promise<void> {
  try {
    const gfxPath = getGfxIniPath(dolphinPath)
    const content = await fsPromises.readFile(gfxPath, 'utf8')
    const updated = content.replace(
      /^EFBScale\s*=.*$/m,
      `EFBScale = ${efbScale}`,
    )
    await fsPromises.writeFile(gfxPath, updated)
  } catch {
    // GFX.ini not found or unreadable — continue with Dolphin defaults
  }
}

export function createOutputDirectory(basePath: string): string {
  let name = 'output'
  let count = 1
  while (fs.existsSync(path.resolve(basePath, name))) {
    name = `output_${count}`
    count += 1
  }
  const dir = path.resolve(basePath, name)
  fs.mkdirSync(dir)
  return dir
}

export function getFFMPEGPath() {
  if (process.env.NODE_ENV === 'development') {
    return 'ffmpeg'
  }

  const resourcesPath = process.resourcesPath
  const type = os.type()
  switch (type) {
    case 'Linux':
      return path.resolve(resourcesPath, 'ffmpeg', 'ffmpeg-linux-x64')
    case 'Windows_NT':
      return path.resolve(resourcesPath, 'ffmpeg', 'ffmpeg-win32-x64.exe')
    case 'Darwin':
    default:
      throw new Error('no os?')
  }
}
