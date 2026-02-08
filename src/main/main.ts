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
import { app, BrowserWindow, shell, ipcMain } from 'electron'
import type { Event } from 'electron'
import MenuBuilder from './menu'
import { resolveHtmlPath } from './util'
import Controller from './controller'
import { runWorkflow } from './workflow'
import { logMain } from './logger'
import { closeDb } from './dbConnection'
import { autoUpdater } from 'electron-updater'

let mainWindow: BrowserWindow | null = null
let controller: Controller | null = null

if (process.env.NODE_ENV === 'production') {
  const sourceMapSupport = require('source-map-support')
  sourceMapSupport.install()
}

const isDebug =
  process.env.NODE_ENV === 'development' || process.env.DEBUG_PROD === 'true'

if (isDebug) {
  require('electron-debug')()
}

process.on('uncaughtException', (error) => {
  logMain('uncaughtException', error)
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

  mainWindow = new BrowserWindow({
    show: false,
    width: process.env.NODE_ENV === 'development' ? 1200 : 875,
    height: 728,
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
        mainWindow?.webContents.send('update-progress', Math.round(progress.percent))
      })
      autoUpdater.on('update-downloaded', () => {
        mainWindow?.webContents.send('update-downloaded')
      })
      ipcMain.on('download-update', () => {
        autoUpdater.downloadUpdate()
      })
      ipcMain.on('install-update', () => {
        autoUpdater.quitAndInstall()
      })
      autoUpdater.checkForUpdates()
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  const menuBuilder = new MenuBuilder(mainWindow)
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

const shutdownCleanup = () => {
  if (controller) {
    controller.cleanup()
    controller = null
  }
  closeDb()
}

app.on('before-quit', shutdownCleanup)

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

app
  .whenReady()
  .then(() => {
    createWindow()
    app.on('activate', () => {
      // On macOS it's common to re-create a window in the app when the
      // dock icon is clicked and there are no other windows open.
      if (mainWindow === null) createWindow()
    })
  })
  .catch(console.log)
