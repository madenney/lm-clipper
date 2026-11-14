import fs from 'fs'
import path from 'path'
import { app, protocol } from 'electron'
import { logMain } from './logger'

/**
 * The full-zoom card's Watch panel plays clips with slippi-viewer, which loads
 * each character's animation pack from `<zips-base-url>zips/<name>.zip`. The
 * packs ship with the app (assets/zips, 26 files, ~90 MB) and are served here as
 * lunar-assets://app/zips/<name>.zip. Nothing else is reachable through it.
 */
export const VIEWER_SCHEME = 'lunar-assets'

const ZIP_RE = /^\/zips\/([A-Za-z]{2,32})\.zip$/

/** Before app ready: let the renderer fetch() the scheme. */
export function registerViewerScheme() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: VIEWER_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
      },
    },
  ])
}

export function zipsDir(): string {
  // In development the compiled main runs from .erb/dll, which can be a symlink
  // into another checkout, so "two folders up from this file" may not be this
  // app at all: use the app folder Electron was started with.
  return app.isPackaged
    ? path.join(process.resourcesPath, 'assets', 'zips')
    : path.join(app.getAppPath(), 'assets', 'zips')
}

/** After app ready. */
export function handleViewerScheme() {
  protocol.handle(VIEWER_SCHEME, async (request) => {
    const url = new URL(request.url)
    const m = ZIP_RE.exec(url.pathname)
    const file = m ? path.join(zipsDir(), `${m[1]}.zip`) : null
    if (!file || !fs.existsSync(file)) {
      // e.g. "undefined.zip": the viewer asks by character number, and one past
      // its 26 packs has no name. Logged so the replay can be tracked down.
      logMain(
        `viewer: no animation pack for ${request.url} (looked in ${zipsDir()})`,
      )
      return new Response('Not found', { status: 404 })
    }
    // The renderer's page (localhost in dev, file:// packaged) is another origin:
    // say it may read these.
    return new Response(await fs.promises.readFile(file), {
      headers: {
        'Content-Type': 'application/zip',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'max-age=31536000, immutable',
      },
    })
  })
}
