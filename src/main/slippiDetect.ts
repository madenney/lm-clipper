/**
 * Auto-detect the user's existing Slippi setup so we don't have to ask.
 * Everyone running this app already has the Slippi Launcher, which installs the
 * Playback Dolphin build and stores the chosen Melee ISO path in its settings.
 */
import { app } from 'electron'
import fs from 'fs'
import os from 'os'
import path from 'path'

// Stable launcher uses "Slippi Launcher"; the beta uses "Slippi Launcher Beta".
const LAUNCHER_DIRS = ['Slippi Launcher', 'Slippi Launcher Beta']

// Locate the Playback build of Slippi Dolphin (NOT the Netplay build). The
// launcher installs it under a "playback" folder in its config dir.
export function detectPlaybackDolphin(): string | null {
  const appData = app.getPath('appData')
  const candidates: string[] = []

  if (process.platform === 'linux') {
    const exe = 'Slippi_Playback-x86_64.AppImage'
    for (const dir of LAUNCHER_DIRS) {
      candidates.push(path.join(appData, dir, 'playback', exe))
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

// Bounded recursive count of .slp/.slpz files under a folder. Stops at `cap` so
// a huge replay library can't block the main thread.
function countReplays(dir: string, cap: number): number {
  let count = 0
  const stack = [dir]
  while (stack.length > 0 && count < cap) {
    const d = stack.pop() as string
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch (_) {
      continue
    }
    for (const e of entries) {
      if (count >= cap) break
      if (e.isDirectory()) {
        stack.push(path.join(d, e.name))
      } else {
        const lower = e.name.toLowerCase()
        if (lower.endsWith('.slp') || lower.endsWith('.slpz')) count += 1
      }
    }
  }
  return count
}

// Locate the user's Slippi replay folder — the root they set in the Launcher,
// else the platform default — and count the replays in it. Returns null if no
// folder with replays is found.
export const REPLAY_COUNT_CAP = 50000
export function detectSlippiReplayDir(): { dir: string; count: number } | null {
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
    const fallback =
      process.platform === 'win32'
        ? path.join(os.homedir(), 'Documents', 'Slippi')
        : path.join(os.homedir(), 'Slippi')
    if (fs.existsSync(fallback)) dir = fallback
  }

  if (!dir) return null
  const count = countReplays(dir, REPLAY_COUNT_CAP)
  if (count === 0) return null
  return { dir, count }
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
