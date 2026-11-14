import os from 'os'
import path from 'path'
import { clipperDataRoot } from '../dataLocations'

export function getDefaultProjectDir(): string {
  // User-created projects are documents — keep them where users actually browse
  // (a "Lunar Clipper" folder under Documents), consistently on every platform,
  // not buried in a hidden config/data dir. Except on a Windows PC whose
  // Documents is synced to OneDrive and that has not used Clipper yet: there the
  // project databases go to a local folder (dataLocations.ts).
  return path.resolve(clipperDataRoot())
}

// Sensible default filter-thread count from the user's CPU: leave ~2 cores for
// the UI + DB worker, capped to keep per-worker memory in check.
export function autoFilterThreads(): number {
  const cores = os.cpus().length || 2
  return Math.min(Math.max(cores - 2, 1), 8)
}

// Settings that hold a file or folder path: a pasted path may come quoted.
export const PATH_CONFIG_KEYS = new Set([
  'dolphinPath',
  'ssbmIsoPath',
  'outputPath',
  'ffmpegPath',
  'scratchPath',
  'slpzPath',
  'slpzOutputDir',
  'defaultProjectDirectory',
])
