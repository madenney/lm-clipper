import { URL, pathToFileURL } from 'url'
import path from 'path'
import fs from 'fs'
import { app } from 'electron'

export function resolveHtmlPath(htmlFileName: string) {
  if (process.env.NODE_ENV === 'development') {
    const port = process.env.PORT || 1212
    const url = new URL(`http://localhost:${port}`)
    url.pathname = htmlFileName
    return url.href
  }
  // pathToFileURL: a '#', '%' or space in the install folder (a user called
  // "Bob#1") would otherwise cut the URL short and leave the window blank.
  return pathToFileURL(path.resolve(__dirname, '../renderer/', htmlFileName))
    .href
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

// Helper binaries shipped in resources/ by electron-builder extraResources
// (package.json build.<os>.extraResources). Linux and Windows ship x64 only;
// macOS ships one build per arch (arm64 / x64), named after process.arch.
// .erb/scripts/check-bundled-binaries.js lists the same names: keep in step.
export function bundledBinaryName(
  tool: 'ffmpeg' | 'slpz',
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
) {
  switch (platform) {
    case 'linux':
      return `${tool}-linux-x64`
    case 'win32':
      return `${tool}-win32-x64.exe`
    case 'darwin':
      return `${tool}-darwin-${arch}`
    default:
      throw new Error(`Unsupported platform for bundled ${tool}: ${platform}`)
  }
}

export function getSlpzPath() {
  if (process.env.NODE_ENV === 'development') {
    return 'slpz'
  }
  return path.resolve(process.resourcesPath, 'slpz', bundledBinaryName('slpz'))
}

export function getAssetPath(...segments: string[]) {
  const root =
    process.env.NODE_ENV === 'development'
      ? path.resolve(app.getAppPath(), 'assets')
      : path.resolve(process.resourcesPath, 'assets')
  return path.resolve(root, ...segments)
}

export function getFFMPEGPath() {
  if (process.env.NODE_ENV === 'development') {
    return 'ffmpeg'
  }
  return path.resolve(
    process.resourcesPath,
    'ffmpeg',
    bundledBinaryName('ffmpeg'),
  )
}
