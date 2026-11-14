import { app, dialog, shell, IpcMainEvent, OpenDialogOptions } from 'electron'
import os from 'os'
import path from 'path'
import fs, { promises as fsPromises } from 'fs'
import type { ControllerCore } from './context'
import { readClipTrack } from '../clipTrack'
import { appendPerfEvents } from '../perfLogger'
import { logMain, logRenderer, getLogPath } from '../logger'
import { RENDERER_LONGTASK_MS } from '../hangWatchdog'
import { RequestEnvelope, unpackRequest, reply } from '../ipcUtils'
import { isSlpzPath, readReplayBytesAsync } from '../../lib/slpz'
import { isReplayPath } from '../../lib/replayPath'

export type Ctx = Pick<ControllerCore, 'mainWindow'>

const DEBUG_LOG_MAX_BYTES = 5 * 1024 * 1024

export async function getPath(
  ctx: Ctx,
  event: IpcMainEvent,
  data: RequestEnvelope<
    | 'openFile'
    | 'openDirectory'
    | { type: 'openFile' | 'openDirectory'; defaultPath?: string }
  >,
) {
  const { requestId, payload } = unpackRequest<
    | 'openFile'
    | 'openDirectory'
    | { type: 'openFile' | 'openDirectory'; defaultPath?: string }
  >(data)
  const type =
    typeof payload === 'string' ? payload : payload?.type || 'openFile'
  const defaultPath =
    typeof payload === 'object' ? payload?.defaultPath : undefined
  const opts: OpenDialogOptions = { properties: [type] }
  if (defaultPath) {
    let resolved = defaultPath
    if (resolved.startsWith('~')) {
      resolved = path.join(os.homedir(), resolved.slice(1))
    }
    if (resolved.includes('%APPDATA%')) {
      resolved = resolved.replace('%APPDATA%', app.getPath('appData') || '')
    }
    if (fs.existsSync(resolved)) {
      opts.defaultPath = resolved
    }
  }
  const { canceled, filePaths } = await dialog.showOpenDialog(
    ctx.mainWindow,
    opts,
  )
  if (canceled) return reply(event, 'getPath', requestId)
  return reply(event, 'getPath', requestId, filePaths[0])
}

export async function logPerfEvents(
  ctx: Ctx,
  _event: IpcMainEvent,
  data: RequestEnvelope<any>,
) {
  try {
    const { payload } = unpackRequest<any>(data)
    const events = Array.isArray(payload) ? payload : payload?.events
    if (!Array.isArray(events) || events.length === 0) return
    // Big renderer freezes also go to main.log (see hangWatchdog.ts), so one
    // exported file shows main and window hangs side by side.
    for (const e of events) {
      if (
        e?.name === 'longtask' &&
        typeof e.durationMs === 'number' &&
        e.durationMs >= RENDERER_LONGTASK_MS
      ) {
        logMain('renderer-longtask', { ms: Math.round(e.durationMs) })
      }
    }
    await appendPerfEvents(events)
  } catch (error) {
    console.error('Perf log error:', error)
  }
}

export async function debugLog(
  ctx: Ctx,
  _event: IpcMainEvent,
  data: RequestEnvelope<any>,
) {
  try {
    // Developer diagnostics only: a shipped build writes nothing (it used to
    // append forever to logs/debug.log in whatever folder the app was started
    // from, e.g. beside the user's projects; launch review CR-1, OPS-3).
    if (app.isPackaged) return
    const { payload } = unpackRequest<any>(data)
    const lines = Array.isArray(payload) ? payload : []
    if (lines.length === 0) return
    const logPath = path.join(getLogPath(), 'debug.log')
    await fsPromises.mkdir(path.dirname(logPath), { recursive: true })
    // Bounded: start over rather than grow without end.
    const size = await fsPromises.stat(logPath).then(
      (s) => s.size,
      () => 0,
    )
    if (size > DEBUG_LOG_MAX_BYTES)
      await fsPromises.rm(logPath, { force: true })
    await fsPromises.appendFile(
      logPath,
      `${lines.slice(0, 500).map(String).join('\n')}\n`,
    )
  } catch (error) {
    console.error('Debug log error:', error)
  }
}

export async function logRendererError(
  ctx: Ctx,
  event: IpcMainEvent,
  data: RequestEnvelope<any>,
) {
  const { requestId, payload } = unpackRequest<any>(data)
  logRenderer(payload)
  reply(event, 'rendererError', requestId)
}

export async function readReplayFile(event: IpcMainEvent, data: unknown) {
  const { requestId, payload } = unpackRequest<{ path: string }>(data)
  const p = payload?.path
  try {
    if (typeof p !== 'string' || !isReplayPath(p) || !fs.existsSync(p))
      throw new Error('The replay file is not on this computer.')
    const size = (await fsPromises.stat(p)).size
    // A .slpz is about 9x smaller than the .slp it decodes to.
    if (size > (isSlpzPath(p) ? 8 : 64) * 1024 * 1024)
      throw new Error('This replay is too big to watch here.')
    // The viewer reads .slp: a .slpz is decoded here (lib/slpz.ts), read
    // without blocking this thread on the disk.
    reply(event, 'readReplayFile', requestId, {
      bytes: await readReplayBytesAsync(p),
    })
  } catch (err) {
    reply(event, 'readReplayFile', requestId, {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export function getClipTrack(event: IpcMainEvent, data: unknown) {
  const { requestId, payload } = unpackRequest<{
    path: string
    startFrame: number
    endFrame: number
    playerIndexes: number[]
  }>(data)
  try {
    const p = payload
    if (
      !p ||
      typeof p.path !== 'string' ||
      !Number.isFinite(p.startFrame) ||
      !Number.isFinite(p.endFrame) ||
      p.endFrame - p.startFrame > 60 * 60 * 20 ||
      !Array.isArray(p.playerIndexes)
    )
      throw new Error('Not a clip.')
    // The same size ceiling as the viewer: a runaway recording (one is 1.7 GB)
    // must not be read whole into the main process.
    if (
      !fs.existsSync(p.path) ||
      fs.statSync(p.path).size > (isSlpzPath(p.path) ? 8 : 64) * 1024 * 1024
    )
      throw new Error('This replay is too big to map here.')
    const indexes = p.playerIndexes
      .map(Number)
      .filter((i) => Number.isInteger(i) && i >= 0 && i < 4)
    reply(event, 'getClipTrack', requestId, {
      track: readClipTrack(p.path, p.startFrame, p.endFrame, indexes),
    })
  } catch (err) {
    reply(event, 'getClipTrack', requestId, {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export function openFolder(
  _event: IpcMainEvent,
  arg: string | { path: string; create?: boolean },
) {
  const folderPath = typeof arg === 'string' ? arg : arg?.path
  const opts = typeof arg === 'string' ? undefined : arg
  if (!folderPath || typeof folderPath !== 'string') return
  // The setup wizard's output folder may not exist yet: make it, then open it.
  if (opts?.create === true && path.isAbsolute(folderPath)) {
    try {
      fs.mkdirSync(folderPath, { recursive: true })
    } catch (err) {
      console.error('openFolder: could not create', folderPath, err)
    }
  }
  if (!fs.existsSync(folderPath)) {
    console.error('openFolder: path does not exist:', folderPath)
    return
  }
  // Folders only: shell.openPath on a file would run it (an .exe a renderer bug
  // or a crafted project pointed at).
  try {
    if (!fs.statSync(folderPath).isDirectory()) {
      console.error('openFolder: not a folder:', folderPath)
      return
    }
  } catch {
    return
  }
  shell.openPath(folderPath).then((err) => {
    if (err) console.error('shell.openPath failed:', err)
  })
}

export function openDolphinFolder(
  event: IpcMainEvent,
  data: RequestEnvelope<string>,
) {
  const { requestId, payload: rawPath } = unpackRequest<string>(data)
  if (!rawPath) {
    return reply(event, 'openDolphinFolder', requestId, {
      found: false,
    })
  }
  let resolved = rawPath
  if (resolved.startsWith('~')) {
    resolved = path.join(os.homedir(), resolved.slice(1))
  }
  if (resolved.includes('%APPDATA%')) {
    resolved = resolved.replace('%APPDATA%', app.getPath('appData') || '')
  }
  if (!fs.existsSync(resolved)) {
    return reply(event, 'openDolphinFolder', requestId, {
      found: false,
    })
  }
  shell.openPath(resolved).then((err) => {
    if (err) console.error('shell.openPath failed:', err)
  })
  return reply(event, 'openDolphinFolder', requestId, { found: true })
}

export function openLogsFolder() {
  const dir = getLogPath()
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch {
    // opening it below says if it is not there
  }
  shell.openPath(dir).then((err) => {
    if (err) console.error('shell.openPath failed:', err)
  })
}

export function getLogsPath(event: IpcMainEvent) {
  event.reply('logsPath', getLogPath())
}

export async function exportLogs(
  event: IpcMainEvent,
  data: RequestEnvelope<null>,
) {
  const { requestId } = unpackRequest<null>(data)
  try {
    // eslint-disable-next-line global-require
    const JSZip = require('jszip')
    const logsDir = getLogPath()
    const zip = new JSZip()
    try {
      await fsPromises.access(logsDir)
      const files = await fsPromises.readdir(logsDir)
      for (const file of files) {
        const filePath = path.join(logsDir, file)
        const stat = await fsPromises.stat(filePath)
        if (stat.isFile()) {
          zip.file(file, await fsPromises.readFile(filePath))
        }
      }
    } catch (_) {
      // logs dir doesn't exist or is empty
    }
    const downloadsDir = app.getPath('downloads')
    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, '-')
      .slice(0, 19)
    const outPath = path.join(downloadsDir, `lm-clipper-logs-${timestamp}.zip`)
    const buf = await zip.generateAsync({ type: 'nodebuffer' })
    await fsPromises.writeFile(outPath, buf)
    shell.showItemInFolder(outPath)
    return reply(event, 'exportLogs', requestId, { path: outPath })
  } catch (error) {
    console.error('Export logs error:', error)
    return reply(event, 'exportLogs', requestId, {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

export function getAppVersion(event: IpcMainEvent) {
  event.reply('appVersion', app.getVersion())
}

export function openExternal(_event: IpcMainEvent, url: string) {
  if (
    typeof url === 'string' &&
    (url.startsWith('https://') || url.startsWith('http://'))
  ) {
    shell.openExternal(url)
  }
}
