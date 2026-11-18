/**
 * Auto-detect the user's existing Slippi setup so we don't have to ask.
 * Everyone running this app already has the Slippi Launcher, which installs the
 * Playback Dolphin build and stores the chosen Melee ISO path in its settings.
 */
import { app } from 'electron'
import fs from 'fs'
import os from 'os'
import path from 'path'
import * as dolphinRunner from 'slippi-dolphin-runner'
import { streamSlpFilePaths } from '../lib/file'
import { documentsFolder, slippiReplayFallbacks } from './dataLocations'

// Stable launcher uses "Slippi Launcher"; the beta uses "Slippi Launcher Beta".
const LAUNCHER_DIRS = ['Slippi Launcher', 'Slippi Launcher Beta']

/** A path pasted with quotes around it ("C:\\…\\Slippi Dolphin.exe") or spaces. */
export function stripPathQuotes(p: string): string {
  let out = (p ?? '').trim()
  while (
    out.length >= 2 &&
    ((out.startsWith('"') && out.endsWith('"')) ||
      (out.startsWith("'") && out.endsWith("'")))
  ) {
    out = out.slice(1, -1).trim()
  }
  return out
}

/**
 * The Slippi Launcher's config folders under Flatpak sandboxes
 * (~/.var/app/<app id>/config), where a Flatpak'd launcher keeps its Dolphin.
 */
export function flatpakConfigDirs(home = os.homedir()): string[] {
  const root = path.join(home, '.var', 'app')
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(root, d.name, 'config'))
  } catch {
    return []
  }
}

// Locate the Playback build of Slippi Dolphin (NOT the Netplay build). The
// launcher installs it under a "playback" folder in its config dir. On macOS
// this returns the .app; resolveDolphinExecutable finds the binary inside.
export function detectPlaybackDolphin(): string | null {
  const appData = app.getPath('appData')
  const candidates: string[] = []

  if (process.platform === 'linux') {
    const exe = 'Slippi_Playback-x86_64.AppImage'
    for (const root of [appData, ...flatpakConfigDirs()]) {
      for (const dir of LAUNCHER_DIRS) {
        candidates.push(path.join(root, dir, 'playback', exe))
      }
    }
  } else if (process.platform === 'win32') {
    const exe = 'Slippi Dolphin.exe'
    const roots = [appData]
    if (process.env.LOCALAPPDATA) roots.push(process.env.LOCALAPPDATA)
    for (const root of roots) {
      for (const dir of LAUNCHER_DIRS) {
        candidates.push(path.join(root, dir, 'playback', exe))
      }
    }
  } else if (process.platform === 'darwin') {
    const exe = 'Slippi Dolphin.app'
    for (const dir of LAUNCHER_DIRS) {
      candidates.push(path.join(appData, dir, 'playback', exe))
    }
  }

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate
    } catch (_) {
      // try next
    }
  }
  return null
}

/**
 * The executable to launch for a Dolphin path: a macOS .app bundle resolves to
 * Contents/MacOS/<CFBundleExecutable> (from its Info.plist, else the only file
 * there); anything else is returned as is (quotes stripped). slippi-dolphin-runner
 * 0.5.7 exports its own resolveDolphinExecutable; use that when present.
 */
export function resolveDolphinExecutable(dolphinPath: string): string {
  const p = stripPathQuotes(dolphinPath)
  const key = 'resolveDolphinExecutable'
  const fromRunner = (dolphinRunner as unknown as Record<string, unknown>)[key]
  if (typeof fromRunner === 'function') {
    try {
      const r = (fromRunner as (_p: string) => unknown)(p)
      if (typeof r === 'string' && r) return r
    } catch {
      // fall through to our own
    }
  }
  return resolveAppBundle(p)
}

/** Local .app → binary resolution (see resolveDolphinExecutable). */
export function resolveAppBundle(p: string): string {
  if (!/\.app[\\/]*$/i.test(p)) return p
  const bundle = p.replace(/[\\/]+$/, '')
  const macos = path.join(bundle, 'Contents', 'MacOS')
  try {
    const plist = fs.readFileSync(
      path.join(bundle, 'Contents', 'Info.plist'),
      'utf8',
    )
    const m =
      /<key>\s*CFBundleExecutable\s*<\/key>\s*<string>([^<]+)<\/string>/.exec(
        plist,
      )
    if (m) {
      const exe = path.join(macos, m[1].trim())
      if (fs.existsSync(exe)) return exe
    }
  } catch {
    // no readable Info.plist: look in Contents/MacOS
  }
  try {
    const files = fs
      .readdirSync(macos, { withFileTypes: true })
      .filter((d) => d.isFile() && !d.name.startsWith('.'))
    const dolphin = files.find((d) => /dolphin/i.test(d.name)) ?? files[0]
    if (dolphin) return path.join(macos, dolphin.name)
  } catch {
    // not a bundle we can read
  }
  return p
}

// Bounded recursive count of .slp/.slpz files under a folder. Stops at `cap` so
// a huge replay library can't block the main thread.
// Count with the import's own walk (async, so the main process keeps
// responding on a big or cloud-synced folder), stopping at `cap`. Using the
// same walk means the start screen's "Found N replays" matches what an
// import of that folder actually finds.
async function countReplays(dir: string, cap: number): Promise<number> {
  let count = 0
  for await (const _replay of streamSlpFilePaths(dir)) {
    count += 1
    if (count >= cap) break
  }
  return count
}

// Locate the user's Slippi replay folder — the root they set in the Launcher,
// else the platform default — and count the replays in it. Returns null if no
// folder with replays is found.
export const REPLAY_COUNT_CAP = 50000
export async function detectSlippiReplayDir(): Promise<{
  dir: string
  count: number
} | null> {
  const dir = slippiReplayDir()
  if (!dir) return null
  const count = await countReplays(dir, REPLAY_COUNT_CAP)
  if (count === 0) return null
  return { dir, count }
}

/** The folder the Slippi Launcher saves replays to (its setting, else the usual places), or null. No counting. */
export function slippiReplayDir(): string | null {
  const appData = app.getPath('appData')
  let dir: string | null = null

  for (const launcher of LAUNCHER_DIRS) {
    try {
      const settingsPath = path.join(appData, launcher, 'Settings')
      if (!fs.existsSync(settingsPath)) continue
      const json = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
      const root = json?.settings?.rootSlpPath
      if (typeof root === 'string' && root && fs.existsSync(root)) {
        dir = root
        break
      }
    } catch (_) {
      // try next launcher dir
    }
  }

  if (!dir) {
    // The real Documents folder first: with OneDrive's Known Folder Move or a
    // relocated Documents, "~/Documents/Slippi" does not exist (launch review WIN-9).
    for (const candidate of slippiReplayFallbacks(
      documentsFolder(),
      os.homedir(),
    )) {
      if (fs.existsSync(candidate)) {
        dir = candidate
        break
      }
    }
  }

  return dir
}

// Read the Melee ISO path the user already configured in the Slippi Launcher
// (its "Settings" JSON: { settings: { isoPath } }). Only return it if the file
// still exists on disk.
export function detectMeleeIso(): string | null {
  const appData = app.getPath('appData')
  for (const dir of LAUNCHER_DIRS) {
    const settingsPath = path.join(appData, dir, 'Settings')
    try {
      if (!fs.existsSync(settingsPath)) continue
      const json = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
      const isoPath = json?.settings?.isoPath ?? json?.isoPath
      if (
        typeof isoPath === 'string' &&
        isoPath.length > 0 &&
        fs.existsSync(isoPath)
      ) {
        return isoPath
      }
    } catch (_) {
      // unreadable / not JSON — try next launcher dir
    }
  }
  return null
}
