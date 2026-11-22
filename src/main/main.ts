/* eslint global-require: off, no-console: off, promise/always-return: off */

/**
 * This module executes inside of electron's main process. You can start
 * electron renderer process from here and communicate with the other processes
 * through IPC.
 *
 * When running `npm run build` or `npm run build:main`, this file is compiled to
 * `./src/main.js` using webpack. This gives us some performance wins.
 */
// First: a test run's own folders (LM_CLIPPER_TEST_HOME) before anything asks for a path.
import './testHome'
import path from 'path'
import fs from 'fs'
import { app, BrowserWindow, dialog, shell, ipcMain } from 'electron'
import type { Event } from 'electron'
import { autoUpdater } from 'electron-updater'
import MenuBuilder from './menu'
import { resolveHtmlPath } from './util'
import Controller from './controller'
import { runWorkflow } from './workflow'
import { runAutorunDownload, runAutorunFullDbInfo } from './autorunDownload'
import { logMain } from './logger'
import { flushTelemetry, track } from './telemetry'
import { shortUpdateError } from './updaterUtils'
import {
  registerTimedHandlers,
  startMainWatchdog,
  watchWindow,
} from './hangWatchdog'
import { closeDb } from './dbConnection'
import { terminateDbWorker, shutdownDbWorker } from './dbAsync'
import { handleViewerScheme, registerViewerScheme } from './viewerAssets'
import { isLocalUpdateFeed } from '../lib/updateFeed'

// The Watch panel's animation packs (viewerAssets.ts): must be before ready.
registerViewerScheme()

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
// The updater's handlers are registered once per run (see createWindow).
let updaterReady = false

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
  // Anything else: do not half-tear-down (workers and databases closed under a
  // window that stays open and does nothing) and do not stay silent. Say so and
  // offer a restart; whatever is running keeps running until the user answers
  // (launch review REL-1, WIN-23).
  offerRestartAfterCrash(message)
})

let crashDialogOpen = false
function offerRestartAfterCrash(message: string) {
  if (crashDialogOpen) return
  crashDialogOpen = true
  let choice = 1
  try {
    choice = dialog.showMessageBoxSync({
      type: 'error',
      title: 'Lunar Clipper',
      message: 'Lunar Clipper ran into an unexpected problem.',
      detail: `${message.slice(0, 300)}\n\nRestart to carry on. Your projects and replay files are not touched.`,
      buttons: ['Restart', 'Keep going', 'Quit'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    })
  } catch (error) {
    logMain('crash-dialog-failed', error)
  }
  crashDialogOpen = false
  if (choice === 0) {
    // eslint-disable-next-line no-use-before-define
    shutdownCleanup()
    app.relaunch()
    app.exit(0)
  } else if (choice === 2) {
    // eslint-disable-next-line no-use-before-define
    shutdownCleanup()
    app.exit(0)
  }
}

process.on('unhandledRejection', (reason) => {
  logMain('unhandledRejection', reason)
})

// Reloads of a crashed window in the last minute (a window that crashes again
// at once is not reloaded forever).
const rendererReloads: number[] = []

app.on('render-process-gone', (_event, contents, details) => {
  logMain('render-process-gone', {
    id: contents.id,
    reason: details.reason,
    exitCode: details.exitCode,
  })
  // A window that was closed on purpose is not a crash.
  if (details.reason === 'clean-exit') return
  // A crashed or out-of-memory window leaves a blank page. Bring it back: the
  // work in the main process (downloads, imports, recordings) carries on and
  // the page reconnects when it loads again. If it keeps crashing, stop work
  // and say so instead of looping (launch review REL-1).
  const now = Date.now()
  while (rendererReloads.length && now - rendererReloads[0] > 60_000)
    rendererReloads.shift()
  if (
    mainWindow &&
    !mainWindow.isDestroyed() &&
    contents === mainWindow.webContents &&
    rendererReloads.length < 3
  ) {
    rendererReloads.push(now)
    mainWindow.reload()
    return
  }
  // Kill orphaned workers and child processes
  if (controller) controller.cleanup()
  offerRestartAfterCrash(
    `The window stopped (${details.reason}) and could not be restored.`,
  )
})

app.on('child-process-gone', (_event, details) => {
  logMain('child-process-gone', details)
})

/**
 * Test runs (scripts/win-rig): LM_CLIPPER_AUTORUN_WORKFLOW=1 runs workflow.ts,
 * LM_CLIPPER_AUTORUN_FULLDB_INFO the whole-database offer (no download),
 * LM_CLIPPER_AUTORUN_DOWNLOAD a small database download (autorunDownload.ts),
 * in that order; LM_CLIPPER_AUTORUN_REPORT=<file> gets what each did as JSON,
 * and LM_CLIPPER_AUTORUN_EXIT=1 quits afterwards.
 */
async function runAutorun(ctl: Controller) {
  const report: Record<string, unknown> = {
    startedAt: new Date().toISOString(),
  }
  const writeReport = () => {
    const file = process.env.LM_CLIPPER_AUTORUN_REPORT
    if (!file) return
    try {
      fs.writeFileSync(file, JSON.stringify(report, null, 2))
    } catch (error) {
      console.error('Autorun report not written:', error)
    }
  }
  if (process.env.LM_CLIPPER_AUTORUN_WORKFLOW === '1') {
    try {
      report.workflow = await runWorkflow(ctl.config)
    } catch (error) {
      console.error('Workflow failed:', error)
      report.workflow = {
        ok: false,
        error: String((error as Error)?.stack || error),
      }
    }
    writeReport()
  }
  if (process.env.LM_CLIPPER_AUTORUN_FULLDB_INFO === '1') {
    report.fullDbInfo = await runAutorunFullDbInfo(ctl.transferManager)
    writeReport()
  }
  if (process.env.LM_CLIPPER_AUTORUN_DOWNLOAD) {
    report.download = await runAutorunDownload(
      ctl.transferManager,
      process.env.LM_CLIPPER_AUTORUN_DOWNLOAD,
    )
  }
  report.finishedAt = new Date().toISOString()
  writeReport()
  if (process.env.LM_CLIPPER_AUTORUN_EXIT === '1') app.quit()
}

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
      // Explicit secure defaults: defense-in-depth + future-proofing against
      // Electron default changes. The renderer never gets Node; the preload
      // bridges a fixed IPC allowlist via contextBridge.
      contextIsolation: true,
      nodeIntegration: false,
      // nodeIntegrationInWorker removed: the renderer's web workers
      // (trayWebglWorker) are pure webgl/compute and import no
      // Node modules, so granting them Node was unjustified attack surface.
      // SMOKE-TEST after this change: confirm the tray density/webgl
      // visualization still renders.
    },
    resizable: true,
  })

  controller = new Controller(mainWindow)
  watchWindow(mainWindow)
  startMainWatchdog()
  await controller.initArchive()
  registerTimedHandlers(() => controller!.initiateListeners())

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

  if (
    process.env.LM_CLIPPER_AUTORUN_WORKFLOW === '1' ||
    process.env.LM_CLIPPER_AUTORUN_DOWNLOAD ||
    process.env.LM_CLIPPER_AUTORUN_FULLDB_INFO === '1'
  ) {
    runAutorun(controller)
  }

  // Auto-update, production builds only. Registered BEFORE the page loads (not in ready-to-show):
  // the renderer asks for its launch check as soon as React mounts, and a handler that was not
  // there yet dropped that message, so updates were never offered. Once per run (macOS can
  // create the window again).
  if (app.isPackaged && !updaterReady) {
    updaterReady = true
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
    // Test only: LUNAR_UPDATE_FEED_URL points updates at a feed on this computer or the
    // home network (latest.yml + installer, see docs/packaging.md "Testing an update"),
    // so a real update can be tried without publishing a release. Ignored for any
    // other address.
    const testFeed = process.env.LUNAR_UPDATE_FEED_URL
    if (isLocalUpdateFeed(testFeed)) {
      autoUpdater.setFeedURL({ provider: 'generic', url: testFeed as string })
      logMain('updater-test-feed', testFeed)
    }
    autoUpdater.on('update-available', (info: { version: string }) => {
      mainWindow?.webContents.send('update-available', info.version)
    })
    autoUpdater.on('download-progress', (progress: { percent: number }) => {
      mainWindow?.webContents.send(
        'update-progress',
        Math.round(progress.percent),
      )
    })
    autoUpdater.on('update-downloaded', () => {
      mainWindow?.webContents.send('update-downloaded')
    })
    // The renderer's launch check is silent: offline, behind a firewall or before
    // the first release exists it must not put a red banner on every start.
    // electron-updater also emits a global 'error' for that failed check; while a
    // silent check is running that event is only logged (launch review CR-4).
    let silentCheckRunning = false
    autoUpdater.on('error', (err: { message?: string }) => {
      logMain('updater-error', err?.message ?? err)
      if (silentCheckRunning) return
      mainWindow?.webContents.send(
        'update-error',
        shortUpdateError(err?.message, 'Update failed'),
      )
    })
    ipcMain.on('download-update', () => {
      autoUpdater.downloadUpdate().catch((err: { message?: string }) => {
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
    // Run a check on request. `silent` (the renderer's on-mount check) only
    // surfaces a *found* update — no "checking…"/"up to date"/transient-error
    // noise every launch. A non-silent check (Help → Check for Updates) shows
    // the full feedback. Either way a newer version fires autoUpdater's own
    // 'update-available' handler above, which sends the banner.
    ipcMain.on(
      'check-for-updates',
      (_event, payload?: { silent?: boolean }) => {
        const silent = payload?.silent === true
        if (!silent) mainWindow?.webContents.send('update-checking')
        if (silent) silentCheckRunning = true
        autoUpdater
          .checkForUpdates()
          .then((result: { updateInfo?: { version?: string } } | null) => {
            const found = result?.updateInfo?.version
            if (!silent && (!found || found === app.getVersion())) {
              mainWindow?.webContents.send('update-not-available')
            }
          })
          .catch((err: { message?: string }) => {
            logMain('updater-check-failed', err?.message ?? err)
            if (!silent) {
              mainWindow?.webContents.send(
                'update-error',
                shortUpdateError(err?.message, 'Check failed'),
              )
            }
          })
          .finally(() => {
            // The global 'error' event fires just before the promise settles.
            if (silent)
              setTimeout(() => {
                silentCheckRunning = false
              }, 500)
          })
      },
    )
    // NOTE: the launch check is now driven by the renderer once its IPC
    // listeners are mounted (App.tsx sends `check-for-updates {silent:true}`),
    // so a found update can no longer be dropped by the old ready-to-show
    // race. Do NOT re-add an unconditional checkForUpdates() here.
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
    () => controller?.compactProject(),
    (kind) => controller?.extractReplays(kind),
  )
  menuBuilder.buildMenu()
  // Open Recent follows the list as projects are opened and removed.
  if (controller)
    controller.onRecentsChanged = () => {
      menuBuilder.recentProjects = controller?.config?.recentProjects || []
      menuBuilder.buildMenu()
    }
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
  // How long this session was open (app_quit), then a moment for the pings on the wire to finish.
  track('app_quit', { minutes: Math.round(process.uptime() / 60) })
  const pings = flushTelemetry()
  // Watchdog: never let quit hang on a stuck worker.
  const timeout = new Promise((resolve) => {
    setTimeout(resolve, 3000)
  })
  Promise.race([Promise.all([cleanup, pings]), timeout]).finally(() => {
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
  // Quit on every platform. (The macOS habit of staying alive without a window
  // re-created the controller on "activate" and registered every IPC listener
  // twice; macOS builds are off for now. Launch review COMPAT-2.)
  app.quit()
})

if (gotSingleInstanceLock) {
  app
    .whenReady()
    .then(() => {
      // Cold launch via file association: the .lunar path is in our own argv
      // (Windows/Linux). macOS instead fires 'open-file', handled above.
      const initialPath = projectPathFromArgv(process.argv)
      if (initialPath) pendingOpenPath = initialPath
      handleViewerScheme()
      createWindow()
      app.on('activate', () => {
        // On macOS it's common to re-create a window in the app when the
        // dock icon is clicked and there are no other windows open.
        if (mainWindow === null) createWindow()
      })
    })
    .catch(console.log)
}
