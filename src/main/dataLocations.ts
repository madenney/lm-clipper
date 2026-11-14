/*
 * Where Clipper keeps its own big data by default, and which folders are a bad
 * place for it (launch review DL-4, WIN-4, WIN-9, WIN-15, COMPAT-1).
 *
 * The Replay Library (library.sqlite in WAL mode plus 10^5 to 10^6 small .slpz
 * files), the projects (*.lunar, SQLite) and unpacked replays used to default to
 * Documents\Lunar Clipper. On Windows, Documents is very often inside OneDrive
 * (Known Folder Move): sync clients hold files open (EPERM/EBUSY on rename),
 * upload every download, fill the quota, turn replays into placeholders that
 * Dolphin cannot read, and can corrupt a live WAL database. WAL does not work on
 * network shares either.
 */
import os from 'os'
import path from 'path'
import fs from 'fs'
import { app } from 'electron'

/** Names of folders cloud-sync clients create (matched as whole path segments). */
const SYNC_SEGMENTS: [RegExp, string][] = [
  [/^OneDrive(?: - .+| for Business)?$/i, 'OneDrive'],
  [/^Dropbox(?: \(.+\))?$/i, 'Dropbox'],
  [/^(?:Google ?Drive|My Drive)$/i, 'Google Drive'],
  [/^iCloud ?Drive$/i, 'iCloud Drive'],
  [/^Mobile Documents$/i, 'iCloud Drive'],
  [/^(?:Box|Box Sync)$/i, 'Box'],
  [/^(?:MEGAsync|MEGA)$/i, 'MEGA'],
]

const normal = (p: string, platform: NodeJS.Platform) =>
  platform === 'win32' ? p.replace(/\//g, '\\').toLowerCase() : p

/**
 * The cloud-sync service whose folder holds `p`, or null. Recognises the
 * environment variables OneDrive sets (OneDrive, OneDriveConsumer,
 * OneDriveCommercial) and well-known folder names in the path.
 */
export function cloudSyncProvider(
  p: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (!p) return null
  const full = platform === 'win32' ? path.win32.resolve(p) : path.resolve(p)
  const here = normal(full, platform)
  for (const key of ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']) {
    const root = env[key]
    if (!root) continue
    const r = normal(
      platform === 'win32' ? path.win32.resolve(root) : path.resolve(root),
      platform,
    )
    const sep = platform === 'win32' ? '\\' : '/'
    if (here === r || here.startsWith(r.endsWith(sep) ? r : r + sep))
      return 'OneDrive'
  }
  const segments = full.split(/[\\/]/).filter(Boolean)
  for (const seg of segments)
    for (const [re, name] of SYNC_SEGMENTS)
      if (re.test(seg)) return name
  return null
}

/** A UNC path (\\server\share): SQLite's WAL needs shared memory that network
 *  shares do not give, so a library or project there can corrupt. (A drive letter
 *  mapped to a share looks local to Node and is not detected.) */
export function isNetworkPath(
  p: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== 'win32') return false
  return /^[\\/]{2}[^\\/]/.test(p) && !/^[\\/]{2}[?.][\\/]/.test(p)
}

export type StorageConcern = {
  kind: 'network' | 'cloud'
  provider?: string
  message: string
}

/** What is wrong with keeping the library or projects in `folder`, if anything. */
export function storageConcern(
  folder: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): StorageConcern | null {
  if (isNetworkPath(folder, platform))
    return {
      kind: 'network',
      message:
        'This folder is on a network share. Clipper’s library and projects are databases, and they can be damaged on a share (they need a local drive).',
    }
  const provider = cloudSyncProvider(folder, env, platform)
  if (provider)
    return {
      kind: 'cloud',
      provider,
      message: `This folder is synced by ${provider}. It will try to upload every replay, can lock files while Clipper writes them, and can damage the library database. A folder that is not synced works better.`,
    }
  return null
}

type Inputs = {
  platform: NodeJS.Platform
  documents: string
  localAppData: string
  exists: (_p: string) => boolean
  env: NodeJS.ProcessEnv
}

/**
 * The folder holding Clipper's Library, Replays and default projects.
 * Documents\Lunar Clipper, except on Windows when Documents is synced to the
 * cloud and Clipper has not been used there yet: then %LOCALAPPDATA%\Lunar Clipper.
 * An existing Documents\Lunar Clipper is never walked away from (nothing already
 * downloaded is lost track of).
 */
export function chooseDataRoot(i: Inputs): string {
  const legacy = path.join(i.documents, 'Lunar Clipper')
  if (i.platform !== 'win32') return legacy
  if (i.exists(legacy)) return legacy
  if (cloudSyncProvider(i.documents, i.env, i.platform))
    return path.join(i.localAppData, 'Lunar Clipper')
  return legacy
}

/** The user's real Documents folder (Electron follows Windows' Known Folder
 *  redirection: OneDrive, another drive). */
export function documentsFolder(): string {
  try {
    const p = app?.getPath?.('documents')
    if (p) return p
  } catch {
    /* not in Electron (tests, scripts) */
  }
  return path.join(os.homedir(), 'Documents')
}

export function clipperDataRoot(): string {
  return chooseDataRoot({
    platform: process.platform,
    documents: documentsFolder(),
    localAppData:
      process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
    exists: (p) => fs.existsSync(p),
    env: process.env,
  })
}

/** Default Replay Library folder (Settings > Paths can change it). */
export const defaultLibraryFolder = () =>
  path.join(clipperDataRoot(), 'Library')

/** Default folder replay archives are unpacked into. */
export const defaultReplaysFolder = () =>
  path.join(clipperDataRoot(), 'Replays')

/** Where the Slippi Launcher keeps replays when its settings do not say:
 *  Documents\Slippi (the real Documents folder, so OneDrive-redirected and moved
 *  ones are found), then the home folder's. In the order to look. */
export function slippiReplayFallbacks(
  documents: string,
  home: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const list =
    platform === 'win32'
      ? [path.join(documents, 'Slippi'), path.join(home, 'Documents', 'Slippi')]
      : platform === 'darwin'
        ? [path.join(documents, 'Slippi'), path.join(home, 'Slippi')]
        : [path.join(home, 'Slippi')]
  return [...new Set(list)]
}
