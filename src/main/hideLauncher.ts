import path from 'path'
import { app } from 'electron'

// slippi-dolphin-runner hides a Windows recording by running Dolphin on its own
// never-shown desktop through lunar-hidden-launcher.exe. The runner finds its
// bundled copy through import.meta.url, which means nothing once webpack has
// bundled the runner into main.js, and an exe inside app.asar can't run anyway,
// so Clipper passes the path itself (record()'s hideLauncherPath):
//   packaged: resources/hidden-launcher/<exe>, copied UNPACKED by
//             electron-builder (package.json build.win.extraResources;
//             .erb/scripts/check-bundled-binaries.js insists on it)
//   dev:      the runner's own copy in node_modules
export const HIDE_LAUNCHER_EXE = 'lunar-hidden-launcher.exe'
export const HIDE_LAUNCHER_RESOURCE_DIR = 'hidden-launcher'

/** Where the launcher is, packaged or in a dev run. Pure (tested). */
export const resolveHideLauncherPath = (o: {
  packaged: boolean
  resourcesPath?: string
  appPath?: string
}): string =>
  o.packaged
    ? path.join(
        o.resourcesPath || '',
        HIDE_LAUNCHER_RESOURCE_DIR,
        HIDE_LAUNCHER_EXE,
      )
    : path.join(
        o.appPath || process.cwd(),
        'node_modules',
        'slippi-dolphin-runner',
        'native',
        'win',
        'bin',
        HIDE_LAUNCHER_EXE,
      )

/** This run's launcher path (same packaged/dev split as util.ts getFFMPEGPath). */
export const hideLauncherPath = (): string =>
  resolveHideLauncherPath({
    packaged: process.env.NODE_ENV !== 'development',
    resourcesPath: process.resourcesPath,
    appPath:
      app && typeof app.getAppPath === 'function'
        ? app.getAppPath()
        : undefined,
  })
