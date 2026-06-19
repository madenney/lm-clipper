/* eslint global-require: off, no-console: off, promise/always-return: off */

/**
 * This module executes inside of electron's main process. You can start
 * electron renderer process from here and communicate with the other processes
 * through IPC.
 *
 * When running `npm run build` or `npm run build:main`, this file is compiled to
 * `./src/main.js` using webpack. This gives us some performance wins.
 */
import path from 'path'
import fs from 'fs'
import { app, BrowserWindow, shell, ipcMain } from 'electron'
import type { Event } from 'electron'
import { autoUpdater } from 'electron-updater'
import MenuBuilder from './menu'
import { resolveHtmlPath } from './util'
import Controller from './controller'
import { runWorkflow } from './workflow'
import { logMain } from './logger'
import { closeDb } from './dbConnection'
import { terminateDbWorker, shutdownDbWorker } from './dbAsync'

// Set WM_CLASS so Linux desktop environments use our window icon
app.setName('Lunar Clipper')
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('class', 'lm-clipper')
}

let mainWindow: BrowserWindow | null = null
let controller: Controller | null = null

// --- OS file-association open handling (.lunar project files) ---------------
// A .lunar file double-clicked in the OS launches us (cold) or is handed to the
// running instance (warm). We route it through the existing 'openRecentFromMenu'
// renderer flow. `pendingOpenPath` buffers the path until the renderer is ready.
let pendingOpenPath: string | null = null
let rendererReady = false

// Single-instance lock so a double-clicked file opens in the EXISTING window
// instead of spawning a second heavy app instance. If we don't get the lock,
// the already-running instance receives our argv via 'second-instance' below.
// Only in packaged builds — in dev it would fight electronmon's hot-restart
// (a new instance can boot before the old one releases the lock).
const gotSingleInstanceLock = app.isPackaged
  ? app.requestSingleInstanceLock()
  : true

// Pull a .lunar project path out of a process argv array (Windows/Linux pass
// the file this way). Scan from the end; ignore flags and the binary itself.
function projectPathFromArgv(argv: string[]): string | null {
  for (let i = argv.length - 1; i >= 1; i -= 1) {
    const arg = argv[i]
    if (
      arg &&
      !arg.startsWith('-') &&
      arg.toLowerCase().endsWith('.lunar') &&
      fs.existsSync(arg)
    ) {
      return arg
    }
  }
  return null
}

// Send the buffered path to the renderer, but only once it's mounted.
function flushPendingOpen() {
  if (
    pendingOpenPath &&
    rendererReady &&
    mainWindow &&
    !mainWindow.isDestroyed()
  ) {
    mainWindow.webContents.send('openRecentFromMenu', pendingOpenPath)
    pendingOpenPath = null
  }
}

function focusMainWindow() {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
}

if (!gotSingleInstanceLock) {
  // Another instance is already running; it will handle our file. Quit now.
  app.quit()
} else {
  // A second launch (e.g. double-clicking another .lunar file) routes here.
  app.on('second-instance', (_event, argv) => {
    focusMainWindow()
    const p = projectPathFromArgv(argv)
    if (p) {
      pendingOpenPath = p
      flushPendingOpen()
    }
  })

  // macOS delivers the file via this event (never argv), for both cold and
  // warm launches. Must be registered before app 'ready'.
  app.on('open-file', (event, filePath) => {
    event.preventDefault()
    pendingOpenPath = filePath
    focusMainWindow()
    flushPendingOpen()
  })
}

if (process.env.NODE_ENV === 'production') {
  const sourceMapSupport = require('source-map-support')
  sourceMapSupport.install()
}

const isDebug =
  process.env.NODE_ENV === 'development' || process.env.DEBUG_PROD === 'true'

if (isDebug) {
  require('electron-debug')({ showDevTools: false })
}

process.on('uncaughtException', (error) => {
  logMain('uncaughtException', error)
  // "Object has been destroyed" is a benign race: an async task (typically a
  // filter/import worker that outlived the window) tried to send to a
  // webContents that was already closed or reloaded. It is NOT fatal. Swallow
  // it — do not tear down the controller (which would brick the running app)
  // and do not let it bubble to Electron's blocking error dialog (which froze
  // the app into an unrecoverable modal that even electronmon couldn't restart).
  const message = error instanceof Error ? error.message : String(error)
  if (/Object has been destroyed/i.test(message)) {
    return
  }
  shutdownCleanup()
})

process.on('unhandledRejection', (reason) => {
  logMain('unhandledRejection', reason)
})

app.on('render-process-gone', (_event, contents, details) => {
  logMain('render-process-gone', {
    id: contents.id,
    reason: details.reason,
    exitCode: details.exitCode,
  })
  // Kill orphaned workers and child processes
  if (controller) controller.cleanup()
})

app.on('child-process-gone', (_event, details) => {
  logMain('child-process-gone', details)
})

const installExtensions = async () => {
  const installer = require('electron-devtools-installer')
  const forceDownload = !!process.env.UPGRADE_EXTENSIONS
  const extensions = ['REACT_DEVELOPER_TOOLS']

  return installer
    .default(
      extensions.map((name) => installer[name]),
      forceDownload,
    )
    .catch(console.log)
}

const createWindow = async () => {
  if (isDebug) {
    await installExtensions()
  }

  const RESOURCES_PATH = app.isPackaged
    ? path.join(process.resourcesPath, 'assets')
    : path.join(__dirname, '../../assets')

  const getAssetPath = (...paths: string[]): string => {
    return path.join(RESOURCES_PATH, ...paths)
  }

  const { width, height } =
    require('electron').screen.getPrimaryDisplay().workAreaSize
  mainWindow = new BrowserWindow({
    show: false,
    width,
    height,
    icon: getAssetPath('icon.png'),
    webPreferences: {
      preload: app.isPackaged
        ? path.join(__dirname, 'preload.js')
        : path.join(__dirname, '../../.erb/dll/preload.js'),
      nodeIntegrationInWorker: true,
    },
    resizable: true,
  })

  controller = new Controller(mainWindow)
  await controller.initArchive()
  controller.initiateListeners()

  // Once the renderer has mounted (signalled by its first archive request),
  // flush any OS-initiated .lunar file open that arrived before it was ready.
  controller.onRendererReady = () => {
    rendererReady = true
    flushPendingOpen()
  }

  mainWindow.webContents.on(
    'console-message',
    (_event, level, message, line, sourceId) => {
      if (level < 2) return
      logMain('renderer-console', { level, message, line, sourceId })
    },
  )

  const allowedUrl = resolveHtmlPath('index.html')
  const isAllowedNavigation = (url: string) => {
    try {
      const allowed = new URL(allowedUrl)
      const next = new URL(url)
      if (allowed.protocol === 'file:') {
        return url === allowedUrl
      }
      return next.origin === allowed.origin
    } catch (error) {
      return false
    }
  }

  const guardNavigation = (event: Event, url: string) => {
    if (!url || isAllowedNavigation(url)) return
    event.preventDefault()
    logMain('blocked-navigation', { url })
  }

  mainWindow.webContents.on('will-navigate', guardNavigation)
  mainWindow.webContents.on('will-redirect', guardNavigation)

  if (process.env.LM_CLIPPER_AUTORUN_WORKFLOW === '1') {
    runWorkflow(controller.config)
      .then(() => {
        if (process.env.LM_CLIPPER_AUTORUN_EXIT === '1') app.quit()
      })
      .catch((error) => {
        console.error('Workflow failed:', error)
        if (process.env.LM_CLIPPER_AUTORUN_EXIT === '1') app.quit()
      })
  }

  mainWindow.loadURL(resolveHtmlPath('index.html'))

  mainWindow.on('ready-to-show', () => {
    if (!mainWindow) {
      throw new Error('"mainWindow" is not defined')
    }
    if (process.env.START_MINIMIZED) {
      mainWindow.minimize()
    } else {
      mainWindow.show()
    }

    // Check for updates in production
    if (app.isPackaged) {
      autoUpdater.autoDownload = false
      // A build that is itself a prerelease (e.g. 2.0.0-beta.3) follows the
      // beta channel; stable builds stay on the latest channel and never pull
      // a prerelease. The matching beta.yml / latest.yml is selected
      // automatically via detectUpdateChannel (default on).
      autoUpdater.allowPrerelease = app.getVersion().includes('-')
      autoUpdater.logger = {
        info: (...args: unknown[]) => logMain('updater-info', ...args),
        warn: (...args: unknown[]) => logMain('updater-warn', ...args),
        error: (...args: unknown[]) => logMain('updater-error', ...args),
        debug: (..._args: unknown[]) => {},
      }
      autoUpdater.on('update-available', (info) => {
        mainWindow?.webContents.send('update-available', info.version)
      })
      autoUpdater.on('download-progress', (progress) => {
        mainWindow?.webContents.send(
          'update-progress',
          Math.round(progress.percent),
        )
      })
      autoUpdater.on('update-downloaded', () => {
        mainWindow?.webContents.send('update-downloaded')
      })
      autoUpdater.on('error', (err) => {
        logMain('updater-error', err?.message ?? err)
        mainWindow?.webContents.send(
          'update-error',
          err?.message ?? 'Update failed',
        )
      })
      ipcMain.on('download-update', () => {
        autoUpdater.downloadUpdate().catch((err) => {
          logMain('updater-download-failed', err?.message ?? err)
          mainWindow?.webContents.send(
            'update-error',
            err?.message ?? 'Download failed',
          )
        })
      })
      ipcMain.on('install-update', () => {
        autoUpdater.quitAndInstall()
      })
      ipcMain.on('check-for-updates', () => {
        mainWindow?.webContents.send('update-checking')
        autoUpdater
          .checkForUpdates()
          .then((result) => {
            if (
              !result ||
              !result.updateInfo ||
              result.updateInfo.version === app.getVersion()
            ) {
              mainWindow?.webContents.send('update-not-available')
            }
          })
          .catch((err) => {
            logMain('updater-check-failed', err?.message ?? err)
            mainWindow?.webContents.send(
              'update-error',
              err?.message ?? 'Check failed',
            )
          })
      })
      autoUpdater.checkForUpdates().catch((err) => {
        logMain('updater-check-failed', err?.message ?? err)
      })
    }
  })

  mainWindow.on('closed', () => {
    // Tear down any in-flight filter/import/video workers so they don't keep
    // running headless and emitting to a window that no longer exists.
    if (controller) controller.cleanup()
    mainWindow = null
    rendererReady = false
  })

  const menuBuilder = new MenuBuilder(
    mainWindow,
    controller?.config?.recentProjects || [],
  )
  menuBuilder.buildMenu()
  // Open urls in the user's browser
  mainWindow.webContents.setWindowOpenHandler((edata) => {
    if (edata.url.startsWith('http://') || edata.url.startsWith('https://')) {
      shell.openExternal(edata.url)
    }
    return { action: 'deny' }
  })
}

/**
 * Add event listeners...
 */

// The path of the project currently open, captured so we can tidy its sidecar
// files at quit even after the controller is torn down.
const currentProjectPath = (): string | null =>
  controller?.archive?.path || controller?.config?.lastArchivePath || null

// A WAL-mode SQLite db has -wal / -shm sidecar files next to it. Once every
// connection is closed they're disposable clutter (the .lunar is self-contained
// when the -wal is empty). Remove them so a closed project is a single tidy
// file. Guarded: never touch a -wal that still holds un-checkpointed data, and
// any failure (e.g. a handle still open on Windows) is silently left as-is.
const removeWalSidecars = (dbPath: string | null) => {
  if (!dbPath) return
  const wal = `${dbPath}-wal`
  const shm = `${dbPath}-shm`
  try {
    if (fs.existsSync(wal) && fs.statSync(wal).size > 0) return
  } catch (_) {
    return
  }
  for (const f of [wal, shm]) {
    try {
      if (fs.existsSync(f)) fs.unlinkSync(f)
    } catch (_) {
      // benign — another handle still open, or already gone
    }
  }
}

// Synchronous best-effort teardown for abnormal exits (signals / crashes).
const shutdownCleanup = () => {
  const projectPath = currentProjectPath()
  if (controller) {
    controller.cleanup()
    controller = null
  }
  terminateDbWorker()
  closeDb()
  removeWalSidecars(projectPath)
}

// Graceful teardown for normal quit: close every DB connection (including the
// background DbWorker's, awaited). Does NOT touch sidecars — the caller deletes
// them only after confirming this resolved cleanly (see before-quit).
const shutdownCleanupAsync = async () => {
  if (controller) {
    controller.cleanup()
    controller = null
  }
  await shutdownDbWorker()
  closeDb()
}

let quitCleanupStarted = false
app.on('before-quit', (event) => {
  if (quitCleanupStarted) return
  quitCleanupStarted = true
  event.preventDefault()
  // Capture the project path up front — shutdownCleanupAsync nulls the controller.
  const projectPath = currentProjectPath()
  let cleanlyClosed = false
  const cleanup = shutdownCleanupAsync().then(() => {
    cleanlyClosed = true
  })
  // Watchdog: never let quit hang on a stuck worker.
  const timeout = new Promise((resolve) => {
    setTimeout(resolve, 3000)
  })
  Promise.race([cleanup, timeout]).finally(() => {
    // Only remove the WAL sidecars on a confirmed-clean shutdown. If the
    // watchdog won (a worker stuck mid-write, or closeDb still draining), leave
    // -wal/-shm intact so SQLite replays committed data on next open rather
    // than risking deletion of a sidecar a worker still holds.
    if (cleanlyClosed) removeWalSidecars(projectPath)
    app.exit(0)
  })
})

// Ctrl+C from terminal or kill signal
process.on('SIGINT', () => {
  shutdownCleanup()
  process.exit(0)
})
process.on('SIGTERM', () => {
  shutdownCleanup()
  process.exit(0)
})

app.on('window-all-closed', () => {
  // Respect the OSX convention of having the application in memory even
  // after all windows have been closed
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

if (gotSingleInstanceLock) {
  app
    .whenReady()
    .then(() => {
      // Cold launch via file association: the .lunar path is in our own argv
      // (Windows/Linux). macOS instead fires 'open-file', handled above.
      const initialPath = projectPathFromArgv(process.argv)
      if (initialPath) pendingOpenPath = initialPath
      createWindow()
      app.on('activate', () => {
        // On macOS it's common to re-create a window in the app when the
        // dock icon is clicked and there are no other windows open.
        if (mainWindow === null) createWindow()
      })
    })
    .catch(console.log)
}
